use crate::config::ZnConfig;
use anyhow::{anyhow, Result};
use std::path::Path;
use tracing::info;

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

    /// Save fetched config to local zn.json. Keys and tokens (API key, JWT
    /// secret, MCP WebSocket token, audit encryption key) are never written,
    /// and neither are the namespace or KMS settings that equal the
    /// environment: they stay in the environment. The file is written
    /// atomically and owner-only on Unix.
    pub fn persist_local(config: &ZnConfig) -> Result<()> {
        Self::persist_to(Path::new("zn.json"), config)
    }

    fn persist_to(path: &Path, config: &ZnConfig) -> Result<()> {
        ZnConfig::write_private_json(path, &config.without_env_values())
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
