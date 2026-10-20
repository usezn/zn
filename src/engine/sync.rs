use crate::config::ZnConfig;
use anyhow::{anyhow, Result};
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

    /// Save fetched config to local zn.json
    pub fn persist_local(config: &ZnConfig) -> Result<()> {
        let json = serde_json::to_string_pretty(config)?;
        std::fs::write("zn.json", json)?;
        Ok(())
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
