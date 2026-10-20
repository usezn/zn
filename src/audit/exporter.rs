//! SIEM Exporter Module
//!
//! Handles exporting audit logs to external SIEM systems (e.g. Elastic, Splunk, Datadog)
//! via HTTP/JSON.

use crate::audit::AuditEntry;
use crate::config::{default_batch_size, SiemConfig};
use reqwest::Client;
use tokio::sync::broadcast;
use tracing::{error, info, warn};

pub struct SiemExporter {
    config: SiemConfig,
    client: Client,
}

impl SiemExporter {
    pub fn new(mut config: SiemConfig) -> Self {
        // A zero batch size would flush after every event; use the default.
        if config.batch_size == 0 {
            config.batch_size = default_batch_size();
        }
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

    #[test]
    fn zero_batch_size_falls_back_to_the_default() {
        let exporter = SiemExporter::new(config(Some("https://siem.example.com"), 0));
        assert_eq!(exporter.config.batch_size, default_batch_size());
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
}
