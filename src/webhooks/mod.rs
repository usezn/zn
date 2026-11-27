//! Webhook Alerts Module
//!
//! Sends real-time alerts to external services when security events occur.
//! Supports Slack, Discord, and generic webhook endpoints.

use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tracing::{error, info, warn};

/// A URL as it is safe to print: scheme and host only. A webhook URL is a
/// secret (the path or query usually holds the token), and user info before
/// the host can hold a password. The URL is parsed with the same parser the
/// HTTP client uses, so what is printed as the host is the host that
/// receives the request (a backslash ends the authority just like a slash).
/// Anything that does not parse as a URL with a host prints as `<redacted>`.
pub fn redact_url(url: &str) -> String {
    let trimmed = url.trim();
    let Some((_, after_scheme)) = trimmed.split_once("://") else {
        return "<redacted>".to_string();
    };
    // No host before the first separator: the parser would take the next
    // path segment as the host, so print nothing rather than that segment.
    if after_scheme.starts_with(['/', '\\']) {
        return "<redacted>".to_string();
    }
    let Ok(parsed) = reqwest::Url::parse(trimmed) else {
        return "<redacted>".to_string();
    };
    let Some(host) = parsed.host_str().filter(|h| !h.is_empty()) else {
        return "<redacted>".to_string();
    };
    let authority = match parsed.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_string(),
    };
    let has_rest = parsed.path() != "/"
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || trimmed.ends_with(['/', '\\']);
    if has_rest {
        format!("{}://{authority}/<redacted>", parsed.scheme())
    } else {
        format!("{}://{authority}", parsed.scheme())
    }
}

/// Text of a log line about a failed send. The error text has any copy of the
/// request URL removed (see `reqwest::Error::without_url`) and, as a second
/// guard, any remaining occurrence of the configured URL replaced by its
/// redacted form.
fn send_failure_message(url: &str, err: &dyn std::fmt::Display) -> String {
    let text = err.to_string().replace(url, &redact_url(url));
    format!("Failed to send webhook to {}: {}", redact_url(url), text)
}

/// Text of the log line for a delivered webhook.
fn send_success_message(url: &str) -> String {
    format!("Webhook sent successfully to {}", redact_url(url))
}

/// Text of the log line for a webhook answered with a non-success status.
fn non_success_message(url: &str, status: impl std::fmt::Display, body: &str) -> String {
    format!(
        "Webhook to {} returned status {}: {}",
        redact_url(url),
        status,
        body.replace(url, &redact_url(url))
    )
}

/// Most bytes of a non-success webhook response body that are kept for the log.
const LOG_BODY_CAP: usize = 512;
/// Most bytes read from the network in all, only to count what is left out.
const LOG_BODY_READ_LIMIT: usize = 64 * 1024;

/// Turns the start of a response body into one safe log value: any copy of the
/// webhook URL is replaced by its redacted form, the text is cut at
/// `LOG_BODY_CAP` bytes on a character boundary with a marker that says how
/// much was left out, and control characters (C0, DEL, C1, so ANSI escapes, CR,
/// LF and NUL too) are escaped as `\u{..}`, so a remote server cannot add fake
/// log lines or terminal sequences. `extra` is the number of bytes read after
/// `head` and `extra_is_lower_bound` says the count stopped at the read limit.
fn format_body_for_log(head: &[u8], extra: usize, extra_is_lower_bound: bool, url: &str) -> String {
    // The byte offset in the original response where the shown part ends. The
    // omitted count comes from this offset and never from decoded text, so
    // invalid bytes and URL replacement cannot change it.
    let mut cut = head.len().min(LOG_BODY_CAP);
    if cut < head.len() {
        let mut back = 0;
        while back < 3 && cut > 0 && (head[cut] & 0xC0) == 0x80 {
            cut -= 1;
            back += 1;
        }
    }
    if !url.is_empty() && !head.is_empty() {
        let needle = url.as_bytes();
        let mut i = 0;
        while i + needle.len() <= head.len() {
            if &head[i..i + needle.len()] == needle {
                let end = i + needle.len();
                if i < cut && cut < end {
                    cut = end;
                }
                i = end;
            } else {
                i += 1;
            }
        }
    }
    let dropped = extra + (head.len() - cut);
    let text = String::from_utf8_lossy(&head[..cut]);
    let text = if url.is_empty() {
        text.into_owned()
    } else {
        text.replace(url, &redact_url(url))
    };
    let end = text.len();
    let mut out = String::with_capacity(end + 24);
    for c in text.chars() {
        if c.is_control() {
            out.push_str(&format!("\\u{{{:04x}}}", c as u32));
        } else {
            out.push(c);
        }
    }
    if dropped > 0 {
        let at_least = if extra_is_lower_bound {
            "at least "
        } else {
            ""
        };
        out.push_str(&format!("... ({at_least}{dropped} more bytes)"));
    }
    out
}

/// Reads at most `LOG_BODY_READ_LIMIT` bytes of the body and keeps only the
/// first `LOG_BODY_CAP + url_len + 4` of them (room for a URL copy that the log
/// text masks, and for a character cut in two). Returns the kept bytes, how many
/// more were read, and whether the read stopped at the limit.
async fn read_body_head(mut response: reqwest::Response, url_len: usize) -> (Vec<u8>, usize, bool) {
    let keep = LOG_BODY_CAP + url_len + 4;
    let mut head: Vec<u8> = Vec::new();
    let mut extra = 0usize;
    let mut total = 0usize;
    while let Ok(Some(chunk)) = response.chunk().await {
        total += chunk.len();
        let take = keep.saturating_sub(head.len()).min(chunk.len());
        head.extend_from_slice(&chunk[..take]);
        extra += chunk.len() - take;
        if total >= LOG_BODY_READ_LIMIT {
            return (head, extra, true);
        }
    }
    (head, extra, false)
}

/// Webhook configuration
#[derive(Clone, Deserialize, Serialize)]
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

/// Debug output keeps the scheme and host of the URL and hides the rest, so a
/// `{:?}` of the configuration never prints the webhook token.
impl std::fmt::Debug for WebhookConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WebhookConfig")
            .field("url", &redact_url(&self.url))
            .field("webhook_type", &self.webhook_type)
            .field("event_filter", &self.event_filter)
            .field("status_filter", &self.status_filter)
            .field("enabled", &self.enabled)
            .finish()
    }
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
                    error!("{}", send_failure_message(&config.url, &e));
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

        let response = self
            .client
            .post(&config.url)
            .json(&body)
            .send()
            .await
            .map_err(reqwest::Error::without_url)?;

        if response.status().is_success() {
            info!("{}", send_success_message(&config.url));
        } else {
            let status = response.status();
            let (head, extra, lower_bound) = read_body_head(response, config.url.len()).await;
            let body = format_body_for_log(&head, extra, lower_bound, &config.url);
            warn!("{}", non_success_message(&config.url, status, &body));
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
    fn webhook_debug_hides_the_path_and_the_query() {
        let url = "https://hooks.example.com/services/T0000/B0000/fake-webhook-token?key=fake-query-secret";
        let c = cfg(url, WebhookType::Slack);
        let out = format!("{:?} {:#?}", c, c);
        assert!(!out.contains("fake-webhook-token"), "{out}");
        assert!(!out.contains("fake-query-secret"), "{out}");
        assert!(!out.contains("T0000"), "{out}");
        assert!(
            out.contains("https://hooks.example.com/<redacted>"),
            "{out}"
        );
    }

    #[test]
    fn redact_url_keeps_scheme_and_host_only() {
        assert_eq!(redact_url("https://example.com"), "https://example.com");
        assert_eq!(
            redact_url("https://example.com/"),
            "https://example.com/<redacted>"
        );
        assert_eq!(
            redact_url("https://user:fake-pass@example.com:8443/a/b?c=d#e"),
            "https://example.com:8443/<redacted>"
        );
        assert_eq!(
            redact_url("https://example.com?token=fake"),
            "https://example.com/<redacted>"
        );
        assert_eq!(redact_url("fake-token-without-scheme"), "<redacted>");
        assert_eq!(redact_url(""), "<redacted>");
        assert_eq!(redact_url("https:///path-only"), "<redacted>");
    }

    #[test]
    fn redact_url_follows_the_client_parser_for_backslashes() {
        assert_eq!(
            redact_url("https://hooks.example.com\\@fake-token/path"),
            "https://hooks.example.com/<redacted>"
        );
        assert_eq!(
            redact_url("https://hooks.example.com\\fake-token"),
            "https://hooks.example.com/<redacted>"
        );
        assert_eq!(redact_url("https://\\fake-token/x"), "<redacted>");
        assert_eq!(
            redact_url("https://[::1]:8080/fake-token"),
            "https://[::1]:8080/<redacted>"
        );
    }

    #[test]
    fn dispatcher_log_messages_do_not_expose_url_secrets() {
        let url = "https://hooks.example.com/services/fake-webhook-token?key=fake-query-secret";
        let err = "error sending request for url (https://hooks.example.com/services/fake-webhook-token?key=fake-query-secret): connection refused";
        let msgs = [
            send_failure_message(url, &err),
            send_success_message(url),
            non_success_message(url, 500, &format!("echo {url}")),
        ];
        for m in &msgs {
            assert!(
                !m.contains("fake-webhook-token"),
                "a log line exposes URL data"
            );
            assert!(
                !m.contains("fake-query-secret"),
                "a log line exposes URL data"
            );
            assert!(
                m.contains("hooks.example.com"),
                "the log line lost its host"
            );
        }
    }

    #[test]
    fn reqwest_errors_carry_no_url_once_stripped() {
        let url = "http://user:fake-pass@127.0.0.1:1/fake-webhook-token?key=fake-query-secret";
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let err = rt
            .block_on(reqwest::Client::new().post(url).send())
            .unwrap_err()
            .without_url();
        let m = send_failure_message(url, &err);
        assert!(
            !m.contains("fake-webhook-token"),
            "a log line exposes URL data"
        );
        assert!(
            !m.contains("fake-query-secret"),
            "a log line exposes URL data"
        );
        assert!(!m.contains("fake-pass"), "a log line exposes URL data");
    }

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

    #[test]
    fn log_body_short_text_is_unchanged() {
        assert_eq!(format_body_for_log(b"nope", 0, false, ""), "nope");
    }

    #[test]
    fn log_body_long_text_is_capped_with_a_marker() {
        let body = vec![b'a'; 2000];
        let out = format_body_for_log(&body, 0, false, "");
        assert!(out.starts_with(&"a".repeat(512)), "{out}");
        assert!(out.ends_with("... (1488 more bytes)"), "{out}");
        assert_eq!(out.len(), 512 + "... (1488 more bytes)".len());
        let out = format_body_for_log(&body[..516], 100, true, "");
        assert!(out.ends_with("... (at least 104 more bytes)"), "{out}");
    }

    #[test]
    fn log_body_control_characters_are_escaped() {
        let out = format_body_for_log(b"x\x1b[31mred\r\n2026 FAKE line\0end\x7f", 0, false, "");
        assert!(!out.chars().any(|c| c.is_control()), "{out:?}");
        assert!(
            out.contains("\\u{001b}[31mred\\u{000d}\\u{000a}2026"),
            "{out}"
        );
        assert!(out.contains("\\u{0000}end\\u{007f}"), "{out}");
        let c1 = format_body_for_log("a\u{85}b\u{9b}c".as_bytes(), 0, false, "");
        assert!(!c1.chars().any(|c| c.is_control()), "{c1:?}");
    }

    #[test]
    fn log_body_cap_inside_a_multibyte_character_does_not_panic() {
        // 511 ASCII bytes, then a 3-byte character that straddles the cap.
        let mut body = vec![b'a'; 511];
        body.extend_from_slice("\u{20ac}\u{20ac}".as_bytes());
        let out = format_body_for_log(&body, 0, false, "");
        assert!(out.starts_with(&"a".repeat(511)), "{out}");
        assert!(!out.contains('\u{20ac}'), "{out}");
        assert!(out.ends_with("... (6 more bytes)"), "{out}");
        // A body that ends inside a character is lossy, not a panic.
        let _ = format_body_for_log(&"\u{20ac}".as_bytes()[..2], 0, false, "");
    }

    #[tokio::test]
    async fn test_send_webhook_non_success_body_is_read_bounded() {
        let big = "z".repeat(300_000);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/hook", listener.local_addr().unwrap());
        tokio::spawn(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 4096];
            let _ = sock.read(&mut buf).await;
            let head = format!(
                "HTTP/1.1 500 Internal Server Error\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                big.len()
            );
            let _ = sock.write_all(head.as_bytes()).await;
            let _ = sock.write_all(big.as_bytes()).await;
        });
        let (mgr, _rx) = WebhookManager::new(vec![]);
        let cfg = cfg(&url, WebhookType::Generic);
        assert!(mgr.send_webhook(&cfg, &alert("DENIED")).await.is_ok());
    }

    #[test]
    fn log_body_masks_the_url_even_near_the_cap() {
        let url = "https://hooks.example.com/services/fake-webhook-token";
        let mut body = "a".repeat(500).into_bytes();
        body.extend_from_slice(url.as_bytes());
        let out = format_body_for_log(&body, 0, false, url);
        assert!(!out.contains("fake-webhook-token"), "{out}");
        assert!(!out.contains("services"), "{out}");
    }

    #[test]
    fn log_body_invalid_utf8_counts_original_bytes() {
        let body = [0xffu8; 512];
        let out = format_body_for_log(&body, 0, false, "");
        assert!(!out.contains("more bytes"), "{out}");
        let body = [0xffu8; 600];
        let out = format_body_for_log(&body, 0, false, "");
        assert!(out.ends_with("... (88 more bytes)"), "{out}");
        let out = format_body_for_log(&body[..516], 84, false, "");
        assert!(out.ends_with("... (88 more bytes)"), "{out}");
    }

    #[test]
    fn log_body_url_redaction_does_not_change_the_omitted_count() {
        let url = "https://hooks.example.com/services/fake-webhook-token";
        // The URL sits wholly inside the shown part: 10 + 53 + 937 = 1000 bytes.
        let mut body = b"0123456789".to_vec();
        body.extend_from_slice(url.as_bytes());
        body.resize(1000, b'a');
        let out = format_body_for_log(&body, 0, false, url);
        assert!(!out.contains("fake-webhook-token"), "{out}");
        assert!(out.ends_with("... (488 more bytes)"), "{out}");
        // The URL straddles the cap: it is shown redacted and counted by its original length.
        let mut body = "a".repeat(500).into_bytes();
        body.extend_from_slice(url.as_bytes());
        body.resize(body.len() + 100, b'b');
        let out = format_body_for_log(&body, 0, false, url);
        assert!(!out.contains("fake-webhook-token"), "{out}");
        assert!(out.ends_with("... (100 more bytes)"), "{out}");
    }
}
