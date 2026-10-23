//! SIEM Exporter Module
//!
//! Handles exporting audit logs to external SIEM systems (e.g. Elastic, Splunk, Datadog)
//! via HTTP/JSON.

use crate::audit::AuditEntry;
use crate::config::SiemConfig;
use reqwest::Client;
use tokio::sync::broadcast;
use tracing::{error, info, warn};

/// The scheme, host and port of `endpoint`, for log lines. The path, the query string and any
/// user info are left out, because a SIEM URL often carries a token there.
fn endpoint_origin(endpoint: &str) -> String {
    match reqwest::Url::parse(endpoint) {
        Ok(url) => match (url.host_str(), url.port()) {
            (Some(host), Some(port)) => format!("{}://{}:{}", url.scheme(), host, port),
            (Some(host), None) => format!("{}://{}", url.scheme(), host),
            _ => "<endpoint without a host>".to_string(),
        },
        Err(_) => "<unparsable endpoint>".to_string(),
    }
}

/// A send error as text, without the request URL that reqwest puts in it.
fn redacted_error(e: reqwest::Error) -> String {
    e.without_url().to_string()
}

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

        info!(
            "SIEM exporter active, sending to {}",
            endpoint_origin(&endpoint)
        );

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
                error!("SIEM export network error: {}", redacted_error(e));
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
    fn endpoint_origin_keeps_only_scheme_host_and_port() {
        assert_eq!(
            endpoint_origin("https://siem.example.test/ingest?token=SECRET123"),
            "https://siem.example.test"
        );
        assert_eq!(
            endpoint_origin(
                "http://user:pass@siem.example.test:8088/services/collector?key=SECRET123"
            ),
            "http://siem.example.test:8088"
        );
        assert_eq!(
            endpoint_origin("not a url SECRET123"),
            "<unparsable endpoint>"
        );
        for e in [
            "https://siem.example.test/ingest?token=SECRET123",
            "http://user:pass@siem.example.test:8088/x?key=SECRET123",
            "not a url SECRET123",
        ] {
            let shown = endpoint_origin(e);
            assert!(!shown.contains("SECRET123") && !shown.contains("pass"));
        }
    }

    #[tokio::test]
    async fn send_error_text_has_no_url_or_token() {
        // Port 1 refuses the connection at once.
        let url = "http://127.0.0.1:1/ingest?token=SECRET123";
        let err = Client::new()
            .post(url)
            .send()
            .await
            .expect_err("nothing listens on port 1");
        // The raw error carries the URL (this is what used to reach the log)...
        assert!(err.to_string().contains("SECRET123"));
        // ...and the redacted text does not.
        let text = redacted_error(err);
        assert!(!text.contains("SECRET123"), "token in: {text}");
        assert!(!text.contains("/ingest"), "path in: {text}");
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
}
