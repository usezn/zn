//! SIEM Exporter Module
//!
//! Handles exporting audit logs to external SIEM systems (e.g. Elastic, Splunk, Datadog)
//! via HTTP/JSON.

use crate::audit::AuditEntry;
use crate::config::SiemConfig;
use reqwest::Client;
use std::time::{Duration, Instant};
use tokio::sync::broadcast;
use tracing::{error, info, warn};

/// Most events kept while the SIEM endpoint is failing. Beyond this the oldest are dropped.
pub const MAX_BUFFERED_EVENTS: usize = 10_000;
/// Approximate cap, in bytes, on the events kept while the endpoint is failing.
pub const MAX_BUFFERED_BYTES: usize = 16 * 1024 * 1024;
/// Time allowed to open a connection to the SIEM endpoint.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// Time allowed for a whole export request, connection included.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
/// The "events dropped" warning is logged at most once per this interval.
const DROP_WARN_INTERVAL: Duration = Duration::from_secs(30);

/// Rough in-memory size of an entry, enough to bound the retry buffer.
fn approx_size(entry: &AuditEntry) -> usize {
    const FIXED: usize = 256;
    FIXED
        + entry.id.len()
        + entry.timestamp.len()
        + entry.event.len()
        + entry.tool_name.len()
        + entry.status.len()
        + entry.policy_match.as_ref().map_or(0, String::len)
        + entry.payload.as_ref().map_or(0, String::len)
        + entry.agent_id.as_ref().map_or(0, String::len)
        + entry.namespace.as_ref().map_or(0, String::len)
}

/// Counts dropped events and rate-limits the warning about them.
struct DropTracker {
    total: u64,
    unreported: u64,
    last_warn: Option<Instant>,
}

impl DropTracker {
    fn new() -> Self {
        Self {
            total: 0,
            unreported: 0,
            last_warn: None,
        }
    }

    fn record(&mut self, dropped: usize) {
        if dropped == 0 {
            return;
        }
        self.total += dropped as u64;
        self.unreported += dropped as u64;
        let due = match self.last_warn {
            None => true,
            Some(t) => t.elapsed() >= DROP_WARN_INTERVAL,
        };
        if due {
            warn!(
                "SIEM export buffer full: dropped {} oldest events ({} dropped in total)",
                self.unreported, self.total
            );
            self.unreported = 0;
            self.last_warn = Some(Instant::now());
        }
    }
}

/// Drop the oldest events until the buffer is within both caps. Returns how many were dropped.
fn enforce_cap(batch: &mut Vec<AuditEntry>, max_events: usize, max_bytes: usize) -> usize {
    let mut drop_n = batch.len().saturating_sub(max_events);
    let mut bytes: usize = batch[drop_n..].iter().map(approx_size).sum();
    // Always keep the newest event, even when it alone is above the byte cap.
    while bytes > max_bytes && drop_n + 1 < batch.len() {
        bytes -= approx_size(&batch[drop_n]);
        drop_n += 1;
    }
    if drop_n > 0 {
        batch.drain(..drop_n);
    }
    drop_n
}

pub struct SiemExporter {
    config: SiemConfig,
    client: Client,
    drops: DropTracker,
}

impl SiemExporter {
    pub fn new(config: SiemConfig) -> Self {
        Self::with_timeouts(config, CONNECT_TIMEOUT, REQUEST_TIMEOUT)
    }

    fn with_timeouts(config: SiemConfig, connect: Duration, request: Duration) -> Self {
        let client = Client::builder()
            .connect_timeout(connect)
            .timeout(request)
            .build()
            .expect("SIEM HTTP client should build");
        Self {
            config,
            client,
            drops: DropTracker::new(),
        }
    }

    /// Run the exporter loop
    pub async fn run(mut self, mut rx: broadcast::Receiver<AuditEntry>) {
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
                            let dropped =
                                enforce_cap(&mut batch, MAX_BUFFERED_EVENTS, MAX_BUFFERED_BYTES);
                            self.drops.record(dropped);
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
                // The batch stays in the buffer and is resent; `enforce_cap` bounds it.
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
    use tokio::io::AsyncReadExt;

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
    fn cap_drops_oldest_events_first() {
        let mut batch: Vec<AuditEntry> = (0..10).map(|i| entry(&format!("e{i}"), None)).collect();
        let dropped = enforce_cap(&mut batch, 4, usize::MAX);
        assert_eq!(dropped, 6);
        let ids: Vec<&str> = batch.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(ids, ["e6", "e7", "e8", "e9"]);
        assert_eq!(enforce_cap(&mut batch, 4, usize::MAX), 0);
    }

    #[test]
    fn byte_cap_drops_oldest_and_keeps_the_newest() {
        let big = "x".repeat(1000);
        let mut batch: Vec<AuditEntry> = (0..5)
            .map(|i| entry(&format!("e{i}"), Some(&big)))
            .collect();
        let one = approx_size(&batch[0]);
        let dropped = enforce_cap(&mut batch, 100, one * 2 + 1);
        assert_eq!(dropped, 3);
        assert_eq!(batch[0].id, "e3");
        // A single event above the cap is kept rather than emptying the buffer.
        let dropped = enforce_cap(&mut batch, 100, 1);
        assert_eq!(dropped, 1);
        assert_eq!(batch.len(), 1);
        assert_eq!(batch[0].id, "e4");
    }

    #[test]
    fn drop_tracker_counts_and_rate_limits_the_warning() {
        let mut t = DropTracker::new();
        t.record(0);
        assert!(t.last_warn.is_none());
        t.record(5);
        assert_eq!((t.total, t.unreported), (5, 0));
        assert!(t.last_warn.is_some());
        // Within the interval: counted, but the warning is held back.
        t.record(3);
        t.record(2);
        assert_eq!((t.total, t.unreported), (10, 5));
    }

    #[tokio::test]
    async fn failed_batches_stay_bounded_and_oldest_are_dropped() {
        // Nothing listens on this port, so every send fails fast.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let endpoint = format!("http://127.0.0.1:{port}/");
        let mut exporter = SiemExporter::with_timeouts(
            config(Some(&endpoint), 100),
            Duration::from_millis(200),
            Duration::from_millis(500),
        );
        let mut batch: Vec<AuditEntry> = (0..20).map(|i| entry(&format!("e{i}"), None)).collect();
        exporter.send_batch(&endpoint, &mut batch).await;
        assert_eq!(batch.len(), 20, "a failed batch is kept for retry");
        let dropped = enforce_cap(&mut batch, 8, usize::MAX);
        exporter.drops.record(dropped);
        assert_eq!(exporter.drops.total, 12);
        assert_eq!(batch.len(), 8);
        assert_eq!(batch[0].id, "e12");
    }

    #[tokio::test]
    async fn hung_endpoint_times_out_instead_of_blocking() {
        // Accepts the connection, reads the request, and never answers.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 1024];
            loop {
                if sock.read(&mut buf).await.unwrap_or(0) == 0 {
                    break;
                }
            }
        });
        let exporter = SiemExporter::with_timeouts(
            config(Some("unused"), 100),
            Duration::from_millis(500),
            Duration::from_millis(400),
        );
        let mut batch = vec![entry("e1", None)];
        let endpoint = format!("http://127.0.0.1:{port}/");
        let started = Instant::now();
        tokio::time::timeout(
            Duration::from_secs(5),
            exporter.send_batch(&endpoint, &mut batch),
        )
        .await
        .expect("send_batch should return on its own timeout");
        assert!(started.elapsed() < Duration::from_secs(3));
        assert_eq!(batch.len(), 1, "a timed-out batch is kept for retry");
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
