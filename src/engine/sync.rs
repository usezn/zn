use crate::config::{
    AuditConfig, CachingConfig, ConsensusConfig, EngineConfig, FusionConfig, GuardrailsConfig,
    KmsConfig, LoopBreakerConfig, ManagedRulesConfig, NeuralConfig, SecurityConfig, ServerConfig,
    ZnConfig,
};
use crate::webhooks::WebhookType;
use anyhow::{anyhow, Result};
use serde::Serialize;
use std::path::Path;
use tracing::info;

/// What `persist_local` writes. It is built field by field from an explicit
/// allow list, so a field added to `ZnConfig` later is not written until it is
/// added here on purpose. Never written: the API key, JWT secret, MCP
/// WebSocket token, audit encryption key, the SIEM token and endpoint (the
/// endpoint may carry credentials), and webhook URLs (a webhook URL is a
/// credential). Webhooks are stored as references (`webhook_refs`, an id plus
/// the non-secret settings); the URL itself stays in the secret store or
/// environment. A reader that loads the file as a `ZnConfig` ignores
/// `webhook_refs` and gets no webhooks from it.
#[derive(Serialize)]
struct PersistedConfig<'a> {
    environment: &'a str,
    server: &'a ServerConfig,
    security: PersistedSecurity<'a>,
    engine: &'a EngineConfig,
    audit: PersistedAudit<'a>,
    webhook_refs: Vec<PersistedWebhookRef<'a>>,
    siem: PersistedSiem,
    kms: PersistedKms<'a>,
    neural: &'a NeuralConfig,
    fusion: &'a FusionConfig,
    managed_rules: &'a ManagedRulesConfig,
    loop_breaker: &'a LoopBreakerConfig,
    caching: &'a CachingConfig,
    consensus: &'a ConsensusConfig,
    guardrails: &'a GuardrailsConfig,
}

#[derive(Serialize)]
struct PersistedSecurity<'a> {
    allowed_origins: &'a [String],
    rate_limit_enabled: bool,
    rate_limit_per_minute: u32,
    namespace: Option<&'a str>,
}

#[derive(Serialize)]
struct PersistedAudit<'a> {
    db_path: &'a str,
    max_logs_in_memory: usize,
    encryption_enabled: bool,
}

#[derive(Serialize)]
struct PersistedSiem {
    batch_size: usize,
}

#[derive(Serialize)]
struct PersistedKms<'a> {
    kms_type: &'a str,
    key_id: Option<&'a str>,
    region: Option<&'a str>,
    allow_config_fallback: bool,
}

#[derive(Serialize)]
struct PersistedWebhookRef<'a> {
    id: String,
    webhook_type: &'a WebhookType,
    event_filter: &'a [String],
    status_filter: &'a [String],
    enabled: bool,
}

impl<'a> PersistedConfig<'a> {
    fn new(c: &'a ZnConfig) -> Self {
        let SecurityConfig {
            allowed_origins,
            rate_limit_enabled,
            rate_limit_per_minute,
            namespace,
            ..
        } = &c.security;
        let AuditConfig {
            db_path,
            max_logs_in_memory,
            encryption_enabled,
            ..
        } = &c.audit;
        let KmsConfig {
            kms_type,
            key_id,
            region,
            allow_config_fallback,
            ..
        } = &c.kms;
        Self {
            environment: &c.environment,
            server: &c.server,
            security: PersistedSecurity {
                allowed_origins,
                rate_limit_enabled: *rate_limit_enabled,
                rate_limit_per_minute: *rate_limit_per_minute,
                namespace: namespace.as_deref(),
            },
            engine: &c.engine,
            audit: PersistedAudit {
                db_path,
                max_logs_in_memory: *max_logs_in_memory,
                encryption_enabled: *encryption_enabled,
            },
            webhook_refs: c
                .webhooks
                .iter()
                .enumerate()
                .map(|(i, w)| PersistedWebhookRef {
                    id: format!("webhook-{}", i + 1),
                    webhook_type: &w.webhook_type,
                    event_filter: &w.event_filter,
                    status_filter: &w.status_filter,
                    enabled: w.enabled,
                })
                .collect(),
            siem: PersistedSiem {
                batch_size: c.siem.batch_size,
            },
            kms: PersistedKms {
                kms_type,
                key_id: key_id.as_deref(),
                region: region.as_deref(),
                allow_config_fallback: *allow_config_fallback,
            },
            neural: &c.neural,
            fusion: &c.fusion,
            managed_rules: &c.managed_rules,
            loop_breaker: &c.loop_breaker,
            caching: &c.caching,
            consensus: &c.consensus,
            guardrails: &c.guardrails,
        }
    }
}

/// Foundation for Centralized Configuration Sync
pub struct ConfigSync;

impl ConfigSync {
    /// Fetch configuration from a remote URL (placeholder for real SaaS sync)
    pub async fn fetch_remote_config(url: &str, api_key: &str) -> Result<ZnConfig> {
        info!("Fetching remote security configuration from: {}", url);

        let client = reqwest::Client::new();
        let response = client
            .get(url)
            .header("Authorization", format!("Bearer {}", api_key))
            .send()
            .await?;

        if !response.status().is_success() {
            return Err(anyhow!("Fetch failed: HTTP {}", response.status()));
        }

        let config: ZnConfig = response.json().await?;
        Ok(config)
    }

    /// Save fetched config to local zn.json through an allow list (see
    /// `PersistedConfig`): keys, tokens, the SIEM endpoint and webhook URLs are
    /// never written, webhooks are stored as references, and the namespace or
    /// KMS settings that equal the environment stay in the environment. The
    /// file is written atomically and owner-only on Unix.
    pub fn persist_local(config: &ZnConfig) -> Result<()> {
        Self::persist_to(Path::new("zn.json"), config)
    }

    fn persist_to(path: &Path, config: &ZnConfig) -> Result<()> {
        let cleaned = config.without_env_values();
        let json = serde_json::to_string_pretty(&PersistedConfig::new(&cleaned))?;
        ZnConfig::write_private_file(path, json.as_bytes())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    /// Serve one HTTP response on a loopback port; the handle yields the request text.
    async fn serve_once(
        status: &'static str,
        body: String,
    ) -> (String, tokio::task::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/config", listener.local_addr().unwrap());
        let handle = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 8192];
            let n = sock.read(&mut buf).await.unwrap();
            let response = format!(
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            sock.write_all(response.as_bytes()).await.unwrap();
            let _ = sock.shutdown().await;
            String::from_utf8_lossy(&buf[..n]).to_string()
        });
        (url, handle)
    }

    #[tokio::test]
    async fn fetch_parses_config_and_sends_bearer_token() {
        let cfg = ZnConfig {
            environment: "staging-example".to_string(),
            ..ZnConfig::default()
        };
        let (url, server) = serve_once("200 OK", serde_json::to_string(&cfg).unwrap()).await;

        let got = ConfigSync::fetch_remote_config(&url, "test-key-not-real")
            .await
            .unwrap();
        assert_eq!(got.environment, "staging-example");

        let request = server.await.unwrap().to_lowercase();
        assert!(request.contains("authorization: bearer test-key-not-real"));
    }

    #[test]
    fn persist_writes_no_environment_values_and_is_owner_only() {
        let dir = std::env::temp_dir().join(format!("zn-persist-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("zn.json");

        // Values the defaults would take from the environment, set directly to
        // avoid touching the process environment from a parallel test. The
        // namespace and KMS values are kept here: they do not equal any
        // environment value.
        let mut cfg = ZnConfig {
            environment: "persist-example".to_string(),
            ..ZnConfig::default()
        };
        cfg.security.api_key = Some("fake-api-key-0000-not-real".to_string());
        cfg.security.jwt_secret = Some("fake-jwt-secret-0000-not-real-pad".to_string());
        cfg.security.mcp_ws_token = Some("fake-ws-token-0000-not-real".to_string());
        cfg.audit.encryption_key = Some("fake-db-key-0000-not-real".to_string());
        cfg.security.namespace = Some("tenant-from-config-example".to_string());

        #[cfg(unix)]
        {
            // A pre-existing world-readable file is replaced by an owner-only one.
            use std::os::unix::fs::PermissionsExt;
            std::fs::write(&path, "{}").unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        }

        ConfigSync::persist_to(&path, &cfg).unwrap();

        let text = std::fs::read_to_string(&path).unwrap();
        for value in [
            "fake-api-key-0000-not-real",
            "fake-jwt-secret-0000-not-real-pad",
            "fake-ws-token-0000-not-real",
            "fake-db-key-0000-not-real",
        ] {
            assert!(!text.contains(value), "{value} leaked into zn.json");
        }
        let back: ZnConfig = serde_json::from_str(&text).unwrap();
        back.validate().unwrap();
        assert_eq!(back.environment, "persist-example");
        assert_eq!(
            back.security.namespace.as_deref(),
            Some("tenant-from-config-example")
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
        // No temporary file is left behind.
        let leftovers = std::fs::read_dir(&dir).unwrap().count();
        assert_eq!(leftovers, 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Leaf paths of a JSON value ("a.b.c"); arrays count as one leaf.
    fn leaf_paths(v: &serde_json::Value, prefix: &str, out: &mut Vec<String>) {
        match v {
            serde_json::Value::Object(m) => {
                for (k, child) in m {
                    let p = if prefix.is_empty() {
                        k.clone()
                    } else {
                        format!("{prefix}.{k}")
                    };
                    leaf_paths(child, &p, out);
                }
            }
            _ => out.push(prefix.to_string()),
        }
    }

    fn all_string_leaves(v: &serde_json::Value, out: &mut Vec<String>) {
        match v {
            serde_json::Value::String(s) => out.push(s.clone()),
            serde_json::Value::Array(a) => a.iter().for_each(|x| all_string_leaves(x, out)),
            serde_json::Value::Object(m) => m.values().for_each(|x| all_string_leaves(x, out)),
            _ => {}
        }
    }

    fn all_keys(v: &serde_json::Value, out: &mut Vec<String>) {
        match v {
            serde_json::Value::Array(a) => a.iter().for_each(|x| all_keys(x, out)),
            serde_json::Value::Object(m) => {
                for (k, x) in m {
                    out.push(k.clone());
                    all_keys(x, out);
                }
            }
            _ => {}
        }
    }

    /// A config with a marker value in every credential-bearing field.
    fn config_with_markers() -> ZnConfig {
        let mut cfg = ZnConfig::default();
        cfg.security.api_key = Some("MARK-api-key-0001".to_string());
        cfg.security.jwt_secret = Some("MARK-jwt-secret-0002-padding-padding".to_string());
        cfg.security.mcp_ws_token = Some("MARK-ws-token-0003".to_string());
        cfg.audit.encryption_key = Some("MARK-db-key-0004".to_string());
        cfg.siem.token = Some("MARK-siem-token-0005".to_string());
        cfg.siem.endpoint = Some(
            "https://user:MARK-siem-pass-0006@siem.example.com/in?key=MARK-siem-q-0007".to_string(),
        );
        cfg.webhooks = serde_json::from_value(serde_json::json!([
            {"url": "https://hooks.example.com/services/MARK-webhook-0008", "webhook_type": "slack",
             "event_filter": ["tool_call"], "status_filter": ["DENIED"]},
            {"url": "https://discord.example.com/api/webhooks/1/MARK-webhook-0009",
             "webhook_type": "discord", "enabled": false}
        ]))
        .unwrap();
        cfg
    }

    #[test]
    fn persisted_file_contains_none_of_the_sensitive_fields() {
        let dir = std::env::temp_dir().join(format!("zn-persist-allow-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("zn.json");

        ConfigSync::persist_to(&path, &config_with_markers()).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        let _ = std::fs::remove_dir_all(&dir);

        // No marker value, however it was embedded.
        assert!(!text.contains("MARK-"), "a marker leaked: {text}");
        // No webhook URL, userinfo or query string of any kind.
        for needle in [
            "hooks.example.com",
            "discord.example.com",
            "siem.example.com",
        ] {
            assert!(!text.contains(needle), "{needle} leaked");
        }

        let value: serde_json::Value = serde_json::from_str(&text).unwrap();
        // No key whose name says it is a credential.
        let mut keys = Vec::new();
        all_keys(&value, &mut keys);
        for k in &keys {
            let k = k.to_lowercase();
            for bad in [
                "token",
                "secret",
                "password",
                "api_key",
                "encryption_key",
                "url",
                "endpoint",
            ] {
                assert!(!k.contains(bad), "credential-like key persisted: {k}");
            }
        }
        // No string value that looks like a URL with credentials.
        let mut strings = Vec::new();
        all_string_leaves(&value, &mut strings);
        for s in &strings {
            assert!(
                !s.contains("://") || !s.contains('@'),
                "URL with credentials: {s}"
            );
        }
        // Webhooks are references: id, type and settings, never the URL.
        let refs = value["webhook_refs"].as_array().unwrap();
        assert_eq!(refs.len(), 2);
        assert_eq!(refs[0]["id"], "webhook-1");
        assert_eq!(refs[0]["webhook_type"], "slack");
        assert_eq!(refs[1]["enabled"], false);
        assert!(value.get("webhooks").is_none());
    }

    #[test]
    fn persisted_fields_are_exactly_the_allow_list() {
        // Every field of ZnConfig is either written or on this explicit
        // exclusion list; a new field fails here until it is classified.
        let cfg = config_with_markers();
        let mut original = Vec::new();
        let mut full = serde_json::to_value(&cfg).unwrap();
        full.as_object_mut().unwrap().remove("webhooks");
        leaf_paths(&full, "", &mut original);
        let cleaned = cfg.without_env_values();
        let mut persisted = serde_json::to_value(PersistedConfig::new(&cleaned)).unwrap();
        persisted.as_object_mut().unwrap().remove("webhook_refs");
        let mut written = Vec::new();
        leaf_paths(&persisted, "", &mut written);

        let mut dropped: Vec<&String> = original.iter().filter(|k| !written.contains(k)).collect();
        dropped.sort();
        assert_eq!(
            dropped,
            [
                "audit.encryption_key",
                "security.api_key",
                "security.jwt_secret",
                "security.mcp_ws_token",
                "siem.endpoint",
                "siem.token",
            ]
        );
        let extra: Vec<&String> = written.iter().filter(|k| !original.contains(k)).collect();
        assert!(extra.is_empty(), "written but not in ZnConfig: {extra:?}");
    }

    #[test]
    fn persisted_config_loads_and_keeps_the_non_sensitive_fields() {
        let mut cfg = config_with_markers();
        cfg.environment = "persist-roundtrip".to_string();
        cfg.server.port = 4321;
        cfg.security.allowed_origins = vec!["https://app.example.com".to_string()];
        cfg.siem.batch_size = 77;
        cfg.audit.db_path = "roundtrip.db".to_string();
        let cleaned = cfg.without_env_values();
        let text = serde_json::to_string_pretty(&PersistedConfig::new(&cleaned)).unwrap();
        let back: ZnConfig = serde_json::from_str(&text).unwrap();
        assert_eq!(back.environment, "persist-roundtrip");
        assert_eq!(back.server.port, 4321);
        assert_eq!(
            back.security.allowed_origins,
            vec!["https://app.example.com"]
        );
        assert_eq!(back.siem.batch_size, 77);
        assert_eq!(back.audit.db_path, "roundtrip.db");
        assert!(back.webhooks.is_empty());
        assert!(back.siem.token.is_none() && back.siem.endpoint.is_none());
    }

    #[test]
    fn env_values_equal_to_the_environment_are_dropped() {
        let ns = std::env::var("ZN_NAMESPACE").ok();
        // Only meaningful when the variable is set; the init integration test
        // sets it in a child process and covers that path.
        let mut cfg = ZnConfig::default();
        cfg.security.namespace = ns.clone();
        let cleaned = cfg.without_env_values();
        if ns.is_some() {
            assert!(cleaned.security.namespace.is_none());
        }
    }

    #[cfg(unix)]
    #[test]
    fn persist_refuses_a_symlink_target() {
        let dir = std::env::temp_dir().join(format!("zn-persist-link-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let real = dir.join("real.json");
        std::fs::write(&real, "{}").unwrap();
        let link = dir.join("zn.json");
        std::os::unix::fs::symlink(&real, &link).unwrap();

        let err = ConfigSync::persist_to(&link, &ZnConfig::default()).unwrap_err();
        assert!(err.to_string().contains("through a link"), "got: {err}");
        assert_eq!(std::fs::read_to_string(&real).unwrap(), "{}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn persist_refuses_a_non_regular_target() {
        use std::os::unix::fs::FileTypeExt;
        let dir = std::env::temp_dir().join(format!("zn-persist-fifo-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("zn.json");
        let made = std::process::Command::new("mkfifo")
            .arg(&target)
            .status()
            .unwrap();
        assert!(made.success());

        let err = ConfigSync::persist_to(&target, &ZnConfig::default()).unwrap_err();
        assert!(err.to_string().contains("not a regular file"), "got: {err}");
        let ft = std::fs::symlink_metadata(&target).unwrap().file_type();
        assert!(ft.is_fifo(), "the FIFO was replaced");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn fetch_reports_http_error_status() {
        let (url, _server) = serve_once("403 Forbidden", "{}".to_string()).await;
        let err = ConfigSync::fetch_remote_config(&url, "k")
            .await
            .unwrap_err();
        assert!(err.to_string().contains("403"), "got: {err}");
    }

    #[tokio::test]
    async fn fetch_rejects_invalid_json_body() {
        let (url, _server) = serve_once("200 OK", "not json".to_string()).await;
        assert!(ConfigSync::fetch_remote_config(&url, "k").await.is_err());
    }

    #[tokio::test]
    async fn fetch_fails_when_server_unreachable() {
        // Bind then drop to obtain a loopback port with nothing listening.
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/config", listener.local_addr().unwrap());
        drop(listener);
        assert!(ConfigSync::fetch_remote_config(&url, "k").await.is_err());
    }
}
