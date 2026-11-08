//! Webhook Alerts Module
//!
//! Sends real-time alerts to external services when security events occur.
//! Supports Slack, Discord, and generic webhook endpoints.

use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tracing::{error, info, warn};

/// Webhook configuration
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct WebhookConfig {
    /// Webhook URL to send alerts to
    pub url: String,
    /// Type of webhook (slack, discord, generic)
    #[serde(default = "default_webhook_type")]
    pub webhook_type: WebhookType,
    /// Only send alerts for these event types (empty = all)
    #[serde(default)]
    pub event_filter: Vec<String>,
    /// Only send alerts for these statuses (e.g., ["DENIED"])
    #[serde(default)]
    pub status_filter: Vec<String>,
    /// Whether this webhook is enabled
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_webhook_type() -> WebhookType {
    WebhookType::Generic
}

fn default_true() -> bool {
    true
}

/// Type of webhook endpoint
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum WebhookType {
    Slack,
    Discord,
    Generic,
}

/// Alert payload to send via webhook
#[derive(Debug, Clone, Serialize)]
pub struct AlertPayload {
    pub event: String,
    pub tool_name: String,
    pub status: String,
    pub timestamp: String,
    pub policy_match: Option<String>,
    pub details: Option<String>,
}

/// Webhook manager for sending alerts
pub struct WebhookManager {
    configs: Vec<WebhookConfig>,
    client: reqwest::Client,
    tx: mpsc::Sender<AlertPayload>,
}

impl WebhookManager {
    /// Create a new webhook manager
    pub fn new(configs: Vec<WebhookConfig>) -> (Self, mpsc::Receiver<AlertPayload>) {
        let (tx, rx) = mpsc::channel(100);
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());

        let enabled_count = configs.iter().filter(|c| c.enabled).count();
        info!(
            "Webhook manager initialized with {} enabled webhooks",
            enabled_count
        );

        (
            Self {
                configs,
                client,
                tx,
            },
            rx,
        )
    }

    /// Get a sender handle for queueing alerts
    pub fn sender(&self) -> mpsc::Sender<AlertPayload> {
        self.tx.clone()
    }

    /// Start the webhook dispatcher loop
    pub async fn run(self, mut rx: mpsc::Receiver<AlertPayload>) {
        info!("Starting webhook dispatcher");

        while let Some(alert) = rx.recv().await {
            for config in &self.configs {
                if !config.enabled {
                    continue;
                }

                // Check filters
                if !config.event_filter.is_empty() && !config.event_filter.contains(&alert.event) {
                    continue;
                }

                if !config.status_filter.is_empty() && !config.status_filter.contains(&alert.status)
                {
                    continue;
                }

                // Send webhook
                if let Err(e) = self.send_webhook(config, &alert).await {
                    error!("Failed to send webhook to {}: {}", config.url, e);
                }
            }
        }
    }

    /// Send a webhook to a specific endpoint
    async fn send_webhook(
        &self,
        config: &WebhookConfig,
        alert: &AlertPayload,
    ) -> anyhow::Result<()> {
        let body = match config.webhook_type {
            WebhookType::Slack => self.format_slack(alert),
            WebhookType::Discord => self.format_discord(alert),
            WebhookType::Generic => serde_json::to_value(alert)?,
        };

        let response = self.client.post(&config.url).json(&body).send().await?;

        if response.status().is_success() {
            info!("Webhook sent successfully to {}", config.url);
        } else {
            warn!(
                "Webhook to {} returned status {}: {}",
                config.url,
                response.status(),
                response.text().await.unwrap_or_default()
            );
        }

        Ok(())
    }

    /// Format alert for Slack webhook
    fn format_slack(&self, alert: &AlertPayload) -> serde_json::Value {
        let color = if alert.status == "DENIED" {
            "danger"
        } else {
            "good"
        };
        let icon = if alert.status == "DENIED" {
            ":no_entry:"
        } else {
            ":white_check_mark:"
        };

        serde_json::json!({
            "attachments": [{
                "color": color,
                "title": format!("{} zn Security Alert", icon),
                "fields": [
                    { "title": "Event", "value": &alert.event, "short": true },
                    { "title": "Status", "value": &alert.status, "short": true },
                    { "title": "Tool", "value": &alert.tool_name, "short": true },
                    { "title": "Policy", "value": alert.policy_match.as_deref().unwrap_or("N/A"), "short": true },
                ],
                "footer": "zn Security Proxy",
                "ts": chrono::Utc::now().timestamp()
            }]
        })
    }

    /// Format alert for Discord webhook
    fn format_discord(&self, alert: &AlertPayload) -> serde_json::Value {
        let color = if alert.status == "DENIED" {
            0xFF0000
        } else {
            0x00FF00
        };
        let icon = if alert.status == "DENIED" {
            ":no_entry:"
        } else {
            ":white_check_mark:"
        };

        serde_json::json!({
            "embeds": [{
                "title": format!("{} zn Security Alert", icon),
                "color": color,
                "fields": [
                    { "name": "Event", "value": &alert.event, "inline": true },
                    { "name": "Status", "value": &alert.status, "inline": true },
                    { "name": "Tool", "value": &alert.tool_name, "inline": true },
                    { "name": "Policy", "value": alert.policy_match.as_deref().unwrap_or("N/A"), "inline": true },
                ],
                "footer": { "text": "zn Security Proxy" },
                "timestamp": &alert.timestamp
            }]
        })
    }
}

/// Send an alert without blocking
pub async fn send_alert(tx: &mpsc::Sender<AlertPayload>, alert: AlertPayload) {
    if tx.send(alert).await.is_err() {
        warn!("Failed to queue webhook alert - channel full or closed");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_webhook_config_defaults() {
        let json = r#"{"url": "https://example.com/webhook"}"#;
        let config: WebhookConfig = serde_json::from_str(json).unwrap();

        assert_eq!(config.webhook_type, WebhookType::Generic);
        assert!(config.enabled);
        assert!(config.event_filter.is_empty());
    }

    #[test]
    fn test_alert_payload_serialization() {
        let alert = AlertPayload {
            event: "TOOL_CALL".to_string(),
            tool_name: "dangerous_tool".to_string(),
            status: "DENIED".to_string(),
            timestamp: "2024-01-15T10:00:00Z".to_string(),
            policy_match: Some("default_security".to_string()),
            details: None,
        };

        let json = serde_json::to_string(&alert).unwrap();
        assert!(json.contains("DENIED"));
        assert!(json.contains("dangerous_tool"));
    }

    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    fn alert(status: &str) -> AlertPayload {
        AlertPayload {
            event: "TOOL_CALL".to_string(),
            tool_name: "fake_tool".to_string(),
            status: status.to_string(),
            timestamp: "2024-01-15T10:00:00Z".to_string(),
            policy_match: Some("fake_policy".to_string()),
            details: None,
        }
    }

    fn cfg(url: &str, kind: WebhookType) -> WebhookConfig {
        WebhookConfig {
            url: url.to_string(),
            webhook_type: kind,
            event_filter: vec![],
            status_filter: vec![],
            enabled: true,
        }
    }

    /// Minimal local HTTP server: answers every request with `status_line`
    /// and records each request body.
    async fn spawn_server(status_line: &'static str) -> (String, Arc<Mutex<Vec<String>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/hook", listener.local_addr().unwrap());
        let bodies = Arc::new(Mutex::new(Vec::new()));
        let seen = bodies.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else {
                    return;
                };
                let seen = seen.clone();
                tokio::spawn(async move {
                    let mut buf = Vec::new();
                    let mut chunk = [0u8; 4096];
                    loop {
                        let n = sock.read(&mut chunk).await.unwrap_or(0);
                        if n == 0 {
                            break;
                        }
                        buf.extend_from_slice(&chunk[..n]);
                        let text = String::from_utf8_lossy(&buf).to_string();
                        if let Some(idx) = text.find("\r\n\r\n") {
                            let len = text[..idx]
                                .lines()
                                .find_map(|l| {
                                    let l = l.to_ascii_lowercase();
                                    l.strip_prefix("content-length:")
                                        .and_then(|v| v.trim().parse::<usize>().ok())
                                })
                                .unwrap_or(0);
                            if text.len() >= idx + 4 + len {
                                seen.lock()
                                    .unwrap()
                                    .push(text[idx + 4..idx + 4 + len].to_string());
                                break;
                            }
                        }
                    }
                    let resp = format!(
                        "{status_line}\r\ncontent-length: 4\r\nconnection: close\r\n\r\nnope"
                    );
                    let _ = sock.write_all(resp.as_bytes()).await;
                    let _ = sock.shutdown().await;
                });
            }
        });
        (url, bodies)
    }

    async fn wait_for(bodies: &Arc<Mutex<Vec<String>>>, n: usize) {
        for _ in 0..200 {
            if bodies.lock().unwrap().len() >= n {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        panic!(
            "expected {n} requests, got {}",
            bodies.lock().unwrap().len()
        );
    }

    #[test]
    fn test_format_slack_denied_and_allowed() {
        let (mgr, _rx) = WebhookManager::new(vec![]);
        let denied = mgr.format_slack(&alert("DENIED"));
        let att = &denied["attachments"][0];
        assert_eq!(att["color"], "danger");
        assert!(att["title"].as_str().unwrap().contains(":no_entry:"));
        assert_eq!(att["fields"][2]["value"], "fake_tool");
        assert_eq!(att["fields"][3]["value"], "fake_policy");
        assert!(att["ts"].as_i64().unwrap() > 0);

        let mut ok = alert("ALLOWED");
        ok.policy_match = None;
        let allowed = mgr.format_slack(&ok);
        assert_eq!(allowed["attachments"][0]["color"], "good");
        assert_eq!(allowed["attachments"][0]["fields"][3]["value"], "N/A");
    }

    #[test]
    fn test_format_discord_denied_and_allowed() {
        let (mgr, _rx) = WebhookManager::new(vec![]);
        let denied = mgr.format_discord(&alert("DENIED"));
        let embed = &denied["embeds"][0];
        assert_eq!(embed["color"], 0xFF0000);
        assert!(embed["title"].as_str().unwrap().contains(":no_entry:"));
        assert_eq!(embed["timestamp"], "2024-01-15T10:00:00Z");
        assert_eq!(embed["fields"][0]["value"], "TOOL_CALL");

        let mut ok = alert("ALLOWED");
        ok.policy_match = None;
        let allowed = mgr.format_discord(&ok);
        assert_eq!(allowed["embeds"][0]["color"], 0x00FF00);
        assert_eq!(allowed["embeds"][0]["fields"][3]["value"], "N/A");
    }

    #[test]
    fn test_manager_counts_and_sender() {
        let mut disabled = cfg("http://127.0.0.1:1/x", WebhookType::Generic);
        disabled.enabled = false;
        let (mgr, mut rx) = WebhookManager::new(vec![
            cfg("http://127.0.0.1:1/y", WebhookType::Slack),
            disabled,
        ]);
        mgr.sender().try_send(alert("DENIED")).unwrap();
        assert_eq!(rx.try_recv().unwrap().tool_name, "fake_tool");
    }

    #[tokio::test]
    async fn test_send_webhook_generic_success() {
        let (url, bodies) = spawn_server("HTTP/1.1 200 OK").await;
        let config = cfg(&url, WebhookType::Generic);
        let (mgr, _rx) = WebhookManager::new(vec![config.clone()]);
        mgr.send_webhook(&config, &alert("DENIED")).await.unwrap();
        let body: serde_json::Value = serde_json::from_str(&bodies.lock().unwrap()[0]).unwrap();
        assert_eq!(body["tool_name"], "fake_tool");
        assert_eq!(body["status"], "DENIED");
    }

    #[tokio::test]
    async fn test_send_webhook_slack_and_discord_bodies() {
        let (url, bodies) = spawn_server("HTTP/1.1 200 OK").await;
        let slack = cfg(&url, WebhookType::Slack);
        let discord = cfg(&url, WebhookType::Discord);
        let (mgr, _rx) = WebhookManager::new(vec![]);
        mgr.send_webhook(&slack, &alert("DENIED")).await.unwrap();
        mgr.send_webhook(&discord, &alert("DENIED")).await.unwrap();
        let all = bodies.lock().unwrap().clone();
        assert!(all.iter().any(|b| b.contains("attachments")));
        assert!(all.iter().any(|b| b.contains("embeds")));
    }

    #[tokio::test]
    async fn test_send_webhook_non_success_status_is_not_an_error() {
        let (url, bodies) = spawn_server("HTTP/1.1 500 Internal Server Error").await;
        let config = cfg(&url, WebhookType::Generic);
        let (mgr, _rx) = WebhookManager::new(vec![]);
        assert!(mgr.send_webhook(&config, &alert("DENIED")).await.is_ok());
        assert_eq!(bodies.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn test_send_webhook_connection_failure_is_an_error() {
        // Bind then drop to obtain a port nothing listens on.
        let port = {
            let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            l.local_addr().unwrap().port()
        };
        let config = cfg(
            &format!("http://127.0.0.1:{port}/hook"),
            WebhookType::Generic,
        );
        let (mgr, _rx) = WebhookManager::new(vec![]);
        assert!(mgr.send_webhook(&config, &alert("DENIED")).await.is_err());
    }

    #[tokio::test]
    async fn test_run_dispatches_with_filters_and_survives_failures() {
        let (url_all, all_bodies) = spawn_server("HTTP/1.1 200 OK").await;
        let (url_denied, denied_bodies) = spawn_server("HTTP/1.1 200 OK").await;
        let (url_event, event_bodies) = spawn_server("HTTP/1.1 200 OK").await;
        let (url_off, off_bodies) = spawn_server("HTTP/1.1 200 OK").await;
        let dead_port = {
            let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            l.local_addr().unwrap().port()
        };

        let mut denied_only = cfg(&url_denied, WebhookType::Generic);
        denied_only.status_filter = vec!["DENIED".to_string()];
        let mut other_event = cfg(&url_event, WebhookType::Generic);
        other_event.event_filter = vec!["OTHER_EVENT".to_string()];
        let mut off = cfg(&url_off, WebhookType::Generic);
        off.enabled = false;
        let configs = vec![
            cfg(
                &format!("http://127.0.0.1:{dead_port}/hook"),
                WebhookType::Generic,
            ),
            cfg(&url_all, WebhookType::Slack),
            denied_only,
            other_event,
            off,
        ];

        let (mgr, rx) = WebhookManager::new(configs);
        let tx = mgr.sender();
        let handle = tokio::spawn(mgr.run(rx));

        send_alert(&tx, alert("ALLOWED")).await;
        send_alert(&tx, alert("DENIED")).await;
        wait_for(&all_bodies, 2).await;
        wait_for(&denied_bodies, 1).await;

        // The manager keeps its own sender, so the loop only ends on abort.
        handle.abort();
        assert!(handle.await.unwrap_err().is_cancelled());

        assert_eq!(all_bodies.lock().unwrap().len(), 2);
        assert_eq!(denied_bodies.lock().unwrap().len(), 1);
        assert!(event_bodies.lock().unwrap().is_empty(), "event filter");
        assert!(off_bodies.lock().unwrap().is_empty(), "disabled webhook");
    }

    #[tokio::test]
    async fn test_send_alert_queues_on_open_channel() {
        let (tx, mut rx) = mpsc::channel(1);
        send_alert(&tx, alert("DENIED")).await;
        assert_eq!(rx.recv().await.unwrap().status, "DENIED");
    }

    #[tokio::test]
    async fn test_send_alert_with_closed_channel_does_not_panic() {
        let (tx, rx) = mpsc::channel(1);
        drop(rx);
        send_alert(&tx, alert("DENIED")).await;
    }

    #[tokio::test]
    async fn test_send_alert_waits_when_channel_is_full() {
        let (tx, mut rx) = mpsc::channel(1);
        send_alert(&tx, alert("FIRST")).await;
        let tx2 = tx.clone();
        let pending = tokio::spawn(async move { send_alert(&tx2, alert("SECOND")).await });
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert!(!pending.is_finished(), "second send blocks while full");
        assert_eq!(rx.recv().await.unwrap().status, "FIRST");
        pending.await.unwrap();
        assert_eq!(rx.recv().await.unwrap().status, "SECOND");
    }
}
