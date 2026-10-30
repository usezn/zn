//! SIEM Exporter Module
//!
//! Handles exporting audit logs to external SIEM systems (e.g. Elastic, Splunk, Datadog)
//! via HTTP/JSON.

use crate::audit::AuditEntry;
use crate::config::SiemConfig;
use reqwest::Client;
use tokio::sync::broadcast;
use tracing::{error, info, warn};

pub struct SiemExporter {
    config: SiemConfig,
    client: Client,
}

impl SiemExporter {
    pub fn new(config: SiemConfig) -> Self {
        Self {
            config,
            client: Client::new(),
        }
    }

    /// Run the exporter loop
    pub async fn run(self, mut rx: broadcast::Receiver<AuditEntry>) {
        let endpoint = match &self.config.endpoint {
            Some(e) => e.clone(),
            None => {
                info!("SIEM exporter disabled (no endpoint configured)");
                return;
            }
        };

        info!("SIEM exporter active, sending to {}", endpoint);

        let mut batch = Vec::with_capacity(self.config.batch_size);

        loop {
            tokio::select! {
                result = rx.recv() => {
                    match result {
                        Ok(entry) => {
                            batch.push(entry);
                            if batch.len() >= self.config.batch_size {
                                self.send_batch(&endpoint, &mut batch).await;
                            }
                        }
                        Err(broadcast::error::RecvError::Lagged(n)) => {
                            warn!("SIEM exporter lagged behind: lost {} events", n);
                        }
                        Err(broadcast::error::RecvError::Closed) => {
                            info!("SIEM exporter stopping: channel closed");
                            break;
                        }
                    }
                }
                // Periodic flush every 5 seconds if batch is not empty
                _ = tokio::time::sleep(std::time::Duration::from_secs(5)) => {
                    if !batch.is_empty() {
                        self.send_batch(&endpoint, &mut batch).await;
                    }
                }
            }
        }
    }

    async fn send_batch(&self, endpoint: &str, batch: &mut Vec<AuditEntry>) {
        let count = batch.len();
        info!("Sending batch of {} events to SIEM", count);

        let mut req = self.client.post(endpoint).json(batch);

        if let Some(token) = &self.config.token {
            req = req.header("Authorization", format!("Bearer {}", token));
        }

        match req.send().await {
            Ok(resp) if resp.status().is_success() => {
                batch.clear();
            }
            Ok(resp) => {
                error!(
                    "SIEM export failed: server returned status {}",
                    resp.status()
                );
                // In production, you might want a retry logic or local buffer
            }
            Err(e) => {
                error!("SIEM export network error: {}", e);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    const ENDPOINT: &str = "https://siem.example.test/ingest";

    fn entry(id: &str, payload: Option<&str>) -> AuditEntry {
        AuditEntry {
            id: id.to_string(),
            timestamp: "2026-10-18T00:00:00Z".to_string(),
            event: "TOOL_CALL".to_string(),
            tool_name: "shell".to_string(),
            status: "DENIED".to_string(),
            policy_match: Some("no-rm".to_string()),
            payload: payload.map(str::to_string),
            agent_id: Some("agent-1".to_string()),
            namespace: None,
            anomaly_score: None,
            nearest_neighbor: None,
            fusion: None,
        }
    }

    fn config(endpoint: Option<&str>, batch_size: usize) -> SiemConfig {
        SiemConfig {
            endpoint: endpoint.map(str::to_string),
            token: None,
            batch_size,
        }
    }

    #[tokio::test]
    async fn exporter_without_endpoint_returns_immediately() {
        let (_tx, rx) = broadcast::channel::<AuditEntry>(4);
        let exporter = SiemExporter::new(config(None, 10));
        tokio::time::timeout(Duration::from_secs(1), exporter.run(rx))
            .await
            .expect("run should return without an endpoint");
    }

    #[tokio::test]
    async fn exporter_stops_when_the_channel_closes_with_nothing_pending() {
        let (tx, rx) = broadcast::channel::<AuditEntry>(4);
        drop(tx);
        let exporter = SiemExporter::new(config(Some(ENDPOINT), 10));
        tokio::time::timeout(Duration::from_secs(1), exporter.run(rx))
            .await
            .expect("run should stop when the channel is closed");
    }

    #[tokio::test]
    async fn lagged_receiver_keeps_running_until_the_channel_closes() {
        let (tx, rx) = broadcast::channel::<AuditEntry>(2);
        for i in 0..4 {
            tx.send(entry(&format!("e{i}"), None)).unwrap();
        }
        drop(tx);
        // The batch size is above the event count, so nothing is flushed over HTTP.
        let exporter = SiemExporter::new(config(Some(ENDPOINT), 100));
        tokio::time::timeout(Duration::from_secs(1), exporter.run(rx))
            .await
            .expect("run should stop after the lag and the close");
    }

    #[test]
    fn batch_body_is_a_json_array_with_escaped_strings() {
        let batch = vec![entry("e1", Some("line1\n\"quoted\" \\ path\t\u{1F600}"))];
        let req = Client::new()
            .post(ENDPOINT)
            .json(&batch)
            .build()
            .expect("request should build");
        let body = req
            .body()
            .and_then(|b| b.as_bytes())
            .expect("JSON body should be buffered");

        let parsed: serde_json::Value =
            serde_json::from_slice(body).expect("body should be valid JSON");
        assert_eq!(parsed[0]["id"], "e1");
        assert_eq!(parsed[0]["tool_name"], "shell");
        assert_eq!(parsed[0]["payload"], "line1\n\"quoted\" \\ path\t\u{1F600}");
        assert!(parsed[0]["namespace"].is_null());

        let raw = std::str::from_utf8(body).expect("body should be UTF-8");
        assert!(raw.contains(r#""payload":"line1\n\"quoted\" \\ path\t"#));
        // `fusion` is skipped when absent.
        assert!(!raw.contains("fusion"));
        assert_eq!(
            req.headers()[reqwest::header::CONTENT_TYPE],
            "application/json"
        );
    }

    // ---- send_batch against a local stub (127.0.0.1, ephemeral port) ----

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    /// One request as the stub saw it.
    struct Seen {
        head: String,
        body: Vec<u8>,
    }

    /// Serve `statuses` in order, one connection each, then stop. Returns the
    /// endpoint and a handle that yields the requests received.
    async fn stub(statuses: Vec<u16>) -> (String, tokio::task::JoinHandle<Vec<Seen>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/ingest", listener.local_addr().unwrap());
        let handle = tokio::spawn(async move {
            let mut seen = Vec::new();
            for status in statuses {
                let (mut sock, _) = listener.accept().await.unwrap();
                let mut buf = Vec::new();
                let mut chunk = [0u8; 4096];
                let (head_end, content_len) = loop {
                    let n = sock.read(&mut chunk).await.unwrap();
                    assert!(n > 0, "client closed before sending a full request");
                    buf.extend_from_slice(&chunk[..n]);
                    if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        let head = String::from_utf8_lossy(&buf[..pos]).to_lowercase();
                        let len = head
                            .lines()
                            .find_map(|l| l.strip_prefix("content-length:"))
                            .map(|v| v.trim().parse::<usize>().unwrap())
                            .unwrap_or(0);
                        break (pos + 4, len);
                    }
                };
                while buf.len() < head_end + content_len {
                    let n = sock.read(&mut chunk).await.unwrap();
                    assert!(n > 0, "client closed before sending the body");
                    buf.extend_from_slice(&chunk[..n]);
                }
                seen.push(Seen {
                    head: String::from_utf8_lossy(&buf[..head_end]).to_string(),
                    body: buf[head_end..head_end + content_len].to_vec(),
                });
                let reply = format!(
                    "HTTP/1.1 {status} X\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
                );
                sock.write_all(reply.as_bytes()).await.unwrap();
                sock.shutdown().await.ok();
            }
            seen
        });
        (endpoint, handle)
    }

    fn two_entries() -> Vec<AuditEntry> {
        vec![entry("a1", Some("example payload")), entry("a2", None)]
    }

    #[tokio::test]
    async fn send_batch_posts_the_events_and_clears_the_batch_on_success() {
        let (endpoint, server) = stub(vec![200]).await;
        let mut cfg = config(Some(&endpoint), 10);
        cfg.token = Some("example-token-not-real".to_string());
        let exporter = SiemExporter::new(cfg);
        let mut batch = two_entries();

        exporter.send_batch(&endpoint, &mut batch).await;

        assert!(batch.is_empty(), "a delivered batch is cleared");
        let seen = server.await.unwrap();
        assert_eq!(seen.len(), 1);
        let head = seen[0].head.to_lowercase();
        assert!(head.starts_with("post /ingest "), "{head}");
        assert!(head.contains("authorization: bearer example-token-not-real"));
        assert!(head.contains("content-type: application/json"));
        let parsed: serde_json::Value = serde_json::from_slice(&seen[0].body).unwrap();
        assert_eq!(parsed.as_array().unwrap().len(), 2);
        assert_eq!(parsed[0]["id"], "a1");
        assert_eq!(parsed[1]["id"], "a2");
    }

    #[tokio::test]
    async fn send_batch_without_a_token_sends_no_authorization_header() {
        let (endpoint, server) = stub(vec![204]).await;
        let exporter = SiemExporter::new(config(Some(&endpoint), 10));
        let mut batch = two_entries();
        exporter.send_batch(&endpoint, &mut batch).await;
        assert!(batch.is_empty());
        let seen = server.await.unwrap();
        assert!(!seen[0].head.to_lowercase().contains("authorization"));
    }

    #[tokio::test]
    async fn send_batch_keeps_the_events_when_the_server_returns_an_error() {
        for status in [500u16, 503, 401, 404] {
            let (endpoint, server) = stub(vec![status]).await;
            let exporter = SiemExporter::new(config(Some(&endpoint), 10));
            let mut batch = two_entries();
            exporter.send_batch(&endpoint, &mut batch).await;
            assert_eq!(batch.len(), 2, "status {status}: events are not dropped");
            assert_eq!(server.await.unwrap().len(), 1);
        }
    }

    #[tokio::test]
    async fn send_batch_keeps_the_events_when_the_connection_is_refused() {
        // Bind and drop to get a local port with nothing listening.
        let port = {
            let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
            l.local_addr().unwrap().port()
        };
        let endpoint = format!("http://127.0.0.1:{port}/ingest");
        let exporter = SiemExporter::new(config(Some(&endpoint), 10));
        let mut batch = two_entries();
        exporter.send_batch(&endpoint, &mut batch).await;
        assert_eq!(batch.len(), 2, "a network error does not drop events");
    }

    #[tokio::test]
    async fn a_failed_batch_is_resent_whole_on_the_next_attempt() {
        // The only retry is the next call: the batch stays in place and is
        // posted again together with anything added since.
        let (endpoint, server) = stub(vec![500, 200]).await;
        let exporter = SiemExporter::new(config(Some(&endpoint), 10));
        let mut batch = two_entries();
        exporter.send_batch(&endpoint, &mut batch).await;
        assert_eq!(batch.len(), 2);
        batch.push(entry("a3", None));
        exporter.send_batch(&endpoint, &mut batch).await;
        assert!(batch.is_empty());

        let seen = server.await.unwrap();
        assert_eq!(seen.len(), 2);
        let first: serde_json::Value = serde_json::from_slice(&seen[0].body).unwrap();
        let second: serde_json::Value = serde_json::from_slice(&seen[1].body).unwrap();
        assert_eq!(first.as_array().unwrap().len(), 2);
        let ids: Vec<&str> = second
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, ["a1", "a2", "a3"]);
    }

    #[tokio::test]
    async fn run_sends_a_full_batch_through_the_stub_and_stops_on_close() {
        let (endpoint, server) = stub(vec![200]).await;
        let (tx, rx) = broadcast::channel::<AuditEntry>(8);
        let exporter = SiemExporter::new(config(Some(&endpoint), 2));
        let task = tokio::spawn(exporter.run(rx));
        tx.send(entry("r1", None)).unwrap();
        tx.send(entry("r2", None)).unwrap();
        let seen = tokio::time::timeout(Duration::from_secs(5), server)
            .await
            .expect("the full batch is sent without waiting for the flush timer")
            .unwrap();
        let parsed: serde_json::Value = serde_json::from_slice(&seen[0].body).unwrap();
        assert_eq!(parsed.as_array().unwrap().len(), 2);
        drop(tx);
        tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .expect("run stops when the channel closes")
            .unwrap();
    }
}
