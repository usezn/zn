//! MCP (Model Context Protocol) Server Pool Module
//!
//! Manages connections to MCP servers with:
//! - Auto-discovery of MCP configurations
//! - Connection pooling and health checks
//! - Support for Stdio and WebSocket transports
//! - Command validation for security
//! - Race-condition-free connection management

use anyhow::{anyhow, Result};
use futures::{future::join_all, SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, BufWriter};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;
use tokio_tungstenite::{connect_async, tungstenite::protocol::Message};
use tracing::{error, info, warn};

/// Maximum time to wait for a pong when checking a WebSocket connection.
const WS_HEALTH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);

/// How long `health_check` waits for a server whose connection is held by an
/// in-flight request before reporting it as down.
const HEALTH_SLOT_WAIT: std::time::Duration = std::time::Duration::from_secs(2);

/// Configuration for an MCP server
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct McpServerConfig {
    /// Command to execute (for stdio transport)
    pub command: Option<String>,
    /// Command line arguments
    #[serde(default)]
    pub args: Vec<String>,
    /// Environment variables
    #[serde(default)]
    pub env: HashMap<String, String>,
    /// URL for WebSocket transport
    pub url: Option<String>,
}

/// Whitelist of allowed commands for MCP servers (security measure)
const ALLOWED_COMMANDS: &[&str] = &[
    "node", "npx", "python", "python3", "uvx", "uv", "cargo", "deno", "bun",
];

/// Validate that a command is in the allowed list
fn validate_command(command: &str) -> Result<()> {
    let cmd_name = Path::new(command)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(command);

    // Check against allowed commands (case-insensitive on Windows)
    let cmd_lower = cmd_name.to_lowercase();
    let cmd_base = cmd_lower.trim_end_matches(".exe").trim_end_matches(".cmd");

    if ALLOWED_COMMANDS.contains(&cmd_base) {
        Ok(())
    } else {
        warn!("Blocked MCP command not in whitelist: {}", command);
        Err(anyhow!(
            "Command '{}' is not in the allowed list. Allowed: {:?}",
            command,
            ALLOWED_COMMANDS
        ))
    }
}

/// A connection to an MCP server (stdio or websocket)
#[allow(clippy::large_enum_variant)]
pub enum McpConnection {
    Stdio {
        name: String,
        child: Child,
        stdin: BufWriter<tokio::process::ChildStdin>,
        stdout: BufReader<tokio::process::ChildStdout>,
    },
    WebSocket {
        name: String,
        url: String,
        ws_stream: Box<
            tokio_tungstenite::WebSocketStream<
                tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
            >,
        >,
    },
}

impl McpConnection {
    /// Connect to an MCP server based on config
    pub async fn connect(name: &str, config: &McpServerConfig) -> Result<Self> {
        if let Some(url) = &config.url {
            let mut attempts = 0;
            let max_attempts = 5;
            let mut delay = std::time::Duration::from_millis(500);

            loop {
                attempts += 1;
                info!(mcp = %name, url = %crate::audit::exporter::endpoint_origin(url), attempt = attempts, "Connecting to MCP via WebSocket");

                match connect_async(url).await {
                    Ok((ws_stream, _)) => {
                        return Ok(Self::WebSocket {
                            name: name.to_string(),
                            url: url.clone(),
                            ws_stream: Box::new(ws_stream),
                        });
                    }
                    Err(e) => {
                        if attempts >= max_attempts {
                            error!(mcp = %name, "Failed to connect after {} attempts: {}", max_attempts, e);
                            return Err(anyhow!("Failed to connect to WS MCP '{}': {}", name, e));
                        }
                        warn!(mcp = %name, "Connection failed: {}. Retrying in {:?}...", e, delay);
                        tokio::time::sleep(delay).await;
                        delay *= 2;
                    }
                }
            }
        } else if let Some(command) = &config.command {
            // Validate command before spawning
            validate_command(command)?;

            info!(mcp = %name, command = %command, "Spawning MCP server");

            let mut cmd = Command::new(command);
            cmd.args(&config.args)
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::inherit())
                .kill_on_drop(true);

            // Validate and apply environment variables
            for (key, value) in &config.env {
                if Self::is_safe_env_var(key) {
                    cmd.env(key, value);
                } else {
                    warn!("Skipping potentially dangerous env var: {}", key);
                }
            }

            let mut child = cmd
                .spawn()
                .map_err(|e| anyhow!("Failed to spawn MCP '{}': {}", name, e))?;

            let stdin = child
                .stdin
                .take()
                .ok_or_else(|| anyhow!("Failed to capture stdin"))?;
            let stdout = child
                .stdout
                .take()
                .ok_or_else(|| anyhow!("Failed to capture stdout"))?;

            Ok(Self::Stdio {
                name: name.to_string(),
                child,
                stdin: BufWriter::new(stdin),
                stdout: BufReader::new(stdout),
            })
        } else {
            Err(anyhow!(
                "MCP config for '{}' must have either 'command' or 'url'",
                name
            ))
        }
    }

    /// Send a request to the MCP server and wait for response
    pub async fn send_request(&mut self, request: &str) -> Result<String> {
        match self {
            Self::Stdio { stdin, stdout, .. } => {
                stdin.write_all(request.as_bytes()).await?;
                stdin.write_all(b"\n").await?;
                stdin.flush().await?;

                let mut response = String::new();
                stdout.read_line(&mut response).await?;
                Ok(response.trim().to_string())
            }
            Self::WebSocket { ws_stream, .. } => {
                ws_stream
                    .send(Message::Text(request.to_string().into()))
                    .await?;

                while let Some(msg) = ws_stream.next().await {
                    match msg? {
                        Message::Text(text) => return Ok(text.to_string()),
                        _ => continue,
                    }
                }
                Err(anyhow!("WebSocket closed without response"))
            }
        }
    }

    /// Check if the MCP connection is still alive.
    ///
    /// Stdio: the child process has not exited. WebSocket: a ping is sent and
    /// the connection is healthy only if the peer answers with a pong within
    /// `WS_HEALTH_TIMEOUT`.
    pub async fn is_alive(&mut self) -> bool {
        self.is_alive_within(WS_HEALTH_TIMEOUT).await
    }

    async fn is_alive_within(&mut self, timeout: std::time::Duration) -> bool {
        match self {
            Self::Stdio { child, .. } => matches!(child.try_wait(), Ok(None)),
            Self::WebSocket { ws_stream, .. } => {
                let ping = async {
                    ws_stream
                        .send(Message::Ping(b"zn-health".to_vec().into()))
                        .await
                        .ok()?;
                    // Other frames may arrive first; skip them until the pong.
                    while let Some(msg) = ws_stream.next().await {
                        match msg {
                            Ok(Message::Pong(_)) => return Some(()),
                            Ok(Message::Close(_)) | Err(_) => return None,
                            Ok(_) => continue,
                        }
                    }
                    None
                };
                matches!(tokio::time::timeout(timeout, ping).await, Ok(Some(())))
            }
        }
    }

    /// Gracefully shutdown the MCP connection
    pub async fn shutdown(&mut self) -> Result<()> {
        match self {
            Self::Stdio { name, child, .. } => {
                info!(mcp = %name, "Killing MCP process");
                let _ = child.kill().await;
            }
            Self::WebSocket {
                name, ws_stream, ..
            } => {
                info!(mcp = %name, "Closing MCP WebSocket");
                let _ = (*ws_stream).close().await;
            }
        }
        Ok(())
    }

    fn is_safe_env_var(name: &str) -> bool {
        const BLOCKED_ENV_VARS: &[&str] = &[
            "LD_PRELOAD",
            "LD_LIBRARY_PATH",
            "DYLD_INSERT_LIBRARIES",
            "DYLD_LIBRARY_PATH",
            "PATH",
            "HOME",
            "USERPROFILE",
            "SHELL",
            "COMSPEC",
        ];
        let name_upper = name.to_uppercase();
        !BLOCKED_ENV_VARS
            .iter()
            .any(|&blocked| blocked == name_upper)
    }
}

/// A connection slot: empty until the first successful connect.
type ConnectionSlot = Arc<Mutex<Option<McpConnection>>>;

/// Pool of MCP server connections
pub struct McpPool {
    /// Server configurations
    configs: HashMap<String, McpServerConfig>,
    /// One slot per server. The outer lock only guards the map itself and is
    /// never held across I/O; each slot has its own lock, so a slow server
    /// only delays requests to that same server.
    connections: Mutex<HashMap<String, ConnectionSlot>>,
    /// Optional Result Cache
    cache: Option<Arc<crate::engine::cache::ResultCache>>,
}

impl McpPool {
    /// Create a new MCP pool with the given configurations
    pub fn new(configs: HashMap<String, McpServerConfig>) -> Self {
        Self {
            configs,
            connections: Mutex::new(HashMap::new()),
            cache: None,
        }
    }

    /// Set the result cache for the pool
    pub fn with_cache(mut self, cache: Arc<crate::engine::cache::ResultCache>) -> Self {
        self.cache = Some(cache);
        self
    }

    /// Auto-discover MCP configurations from standard locations
    pub fn auto_discover() -> Result<Self> {
        let home = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE"))?;

        // Only search in user-controlled directories
        let search_paths = [
            format!("{}/.claude/mcp_servers.json", home),
            format!("{}/.config/claude/mcp_servers.json", home),
        ];

        for path in &search_paths {
            let path_obj = Path::new(path);
            if path_obj.exists() {
                info!("Found MCP config at: {}", path);
                match Self::from_config_file(path) {
                    Ok(pool) => return Ok(pool),
                    Err(e) => {
                        warn!("Failed to load MCP config from {}: {}", path, e);
                        continue;
                    }
                }
            }
        }

        info!("No MCP configuration found, using empty pool");
        Ok(Self::new(HashMap::new()))
    }

    /// Load MCP configurations from a JSON file
    fn from_config_file(path: &str) -> Result<Self> {
        let content = std::fs::read_to_string(path)
            .map_err(|e| anyhow!("Failed to read MCP config file '{}': {}", path, e))?;

        let value: serde_json::Value = serde_json::from_str(&content)
            .map_err(|e| anyhow!("Failed to parse MCP config file '{}': {}", path, e))?;

        let mut configs = HashMap::new();

        if let Some(servers) = value.get("mcpServers").and_then(|v| v.as_object()) {
            for (name, server) in servers {
                let command = server
                    .get("command")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                let url = server
                    .get("url")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());

                if command.is_none() && url.is_none() {
                    warn!(
                        "Skipping MCP server '{}': missing both 'command' and 'url'",
                        name
                    );
                    continue;
                }

                if let Some(ref cmd) = command {
                    if let Err(e) = validate_command(cmd) {
                        warn!("Skipping MCP server '{}': {}", name, e);
                        continue;
                    }
                }

                let args = server
                    .get("args")
                    .and_then(|v| v.as_array())
                    .map(|a| {
                        a.iter()
                            .filter_map(|v| v.as_str().map(|s| s.to_string()))
                            .collect()
                    })
                    .unwrap_or_default();

                let env = server
                    .get("env")
                    .and_then(|v| v.as_object())
                    .map(|o| {
                        o.iter()
                            .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                            .collect()
                    })
                    .unwrap_or_default();

                configs.insert(
                    name.clone(),
                    McpServerConfig {
                        command,
                        args,
                        env,
                        url,
                    },
                );
                info!("Loaded MCP server config: {}", name);
            }
        }

        Ok(Self::new(configs))
    }

    /// Send a request to an MCP server, connecting if necessary.
    /// Supports caching if enabled.
    pub async fn send(&self, name: &str, request: &str, agent_id: Option<&str>) -> Result<String> {
        // 1. Try Cache if it's a tool call
        // (Simplification: We assume the caller manages cache lookup for requests,
        // but we handle STORING the response here).

        let config = self
            .configs
            .get(name)
            .ok_or_else(|| anyhow!("Unknown MCP server: {}", name))?
            .clone();

        // Short critical section: only fetch or create this server's slot.
        let slot = {
            let mut connections = self.connections.lock().await;
            connections.entry(name.to_string()).or_default().clone()
        };

        // Connection work (ping, connect, request) holds only this slot's lock.
        let mut guard = slot.lock().await;
        match guard.as_mut() {
            Some(conn) => {
                if !conn.is_alive().await {
                    info!("MCP '{}' connection died, reconnecting", name);
                    *guard = Some(McpConnection::connect(name, &config).await?);
                }
            }
            None => {
                info!("Establishing new MCP connection: {}", name);
                *guard = Some(McpConnection::connect(name, &config).await?);
            }
        }
        let conn = guard
            .as_mut()
            .expect("connection slot was filled just above");

        let response = conn.send_request(request).await?;
        drop(guard);

        // 2. Store in cache if successful and it looks like a tool call
        if let Some(ref cache) = self.cache {
            if let Some(agent) = agent_id {
                // We only cache successful non-empty JSON responses
                if !response.is_empty() && response.contains("\"result\"") {
                    // We need the tool name and args to cache properly.
                    // This is a bit tricky here as we only have the raw request string.
                    // For now, we'll use a simpler hash-based key if we can't parse it perfectly.
                    cache.set(agent, name, request, response.clone());
                }
            }
        }

        Ok(response)
    }

    /// Get a list of configured MCP server names
    pub fn list_mcps(&self) -> Vec<String> {
        self.configs.keys().cloned().collect()
    }

    /// Clone the slots out of the map so the map lock is released before any I/O.
    async fn snapshot_slots(&self) -> Vec<(String, ConnectionSlot)> {
        let connections = self.connections.lock().await;
        connections
            .iter()
            .map(|(name, slot)| (name.clone(), slot.clone()))
            .collect()
    }

    /// Check the health of all MCP connections.
    ///
    /// Connections are checked in parallel, so the call takes about as long as
    /// the slowest server rather than the sum of all pings. A server whose
    /// connection is held by a request that does not finish within
    /// `HEALTH_SLOT_WAIT` is reported as down (`false`) instead of making the
    /// whole check wait for it.
    pub async fn health_check(&self) -> HashMap<String, bool> {
        self.health_check_with(HEALTH_SLOT_WAIT).await
    }

    async fn health_check_with(&self, slot_wait: std::time::Duration) -> HashMap<String, bool> {
        let slots = self.snapshot_slots().await;

        let checks = slots.into_iter().map(|(name, slot)| async move {
            let alive = match tokio::time::timeout(slot_wait, slot.lock()).await {
                Ok(mut guard) => match guard.as_mut() {
                    Some(conn) => conn.is_alive().await,
                    None => false,
                },
                // Slot still held by an in-flight request: do not wait for it.
                Err(_) => false,
            };
            (name, alive)
        });
        let mut status: HashMap<String, bool> = join_all(checks).await.into_iter().collect();

        for name in self.configs.keys() {
            status.entry(name.clone()).or_insert(false);
        }

        status
    }

    /// Shutdown all MCP connections gracefully
    pub async fn shutdown_all(&self) {
        let slots: Vec<(String, ConnectionSlot)> = {
            let mut connections = self.connections.lock().await;
            connections.drain().collect()
        };
        for (name, slot) in slots {
            if let Some(mut conn) = slot.lock().await.take() {
                info!("Shutting down MCP: {}", name);
                let _ = conn.shutdown().await;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_validate_command_allowed() {
        assert!(validate_command("node").is_ok());
        assert!(validate_command("python").is_ok());
        assert!(validate_command("npx").is_ok());
    }

    #[test]
    fn test_validate_command_blocked() {
        assert!(validate_command("bash").is_err());
        assert!(validate_command("rm").is_err());
    }

    async fn ws_conn(addr: std::net::SocketAddr) -> McpConnection {
        let url = format!("ws://{}", addr);
        let (ws, _) = connect_async(&url).await.unwrap();
        McpConnection::WebSocket {
            name: "t".into(),
            url,
            ws_stream: Box::new(ws),
        }
    }

    #[tokio::test]
    async fn ws_health_check_healthy_server() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(tcp).await.unwrap();
            // Reading drives the automatic pong reply.
            while ws.next().await.is_some() {}
        });
        let mut conn = ws_conn(addr).await;
        assert!(
            conn.is_alive_within(std::time::Duration::from_secs(2))
                .await
        );
        assert!(
            conn.is_alive_within(std::time::Duration::from_secs(2))
                .await
        );
    }

    #[tokio::test]
    async fn ws_health_check_closed_peer_is_unhealthy() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let ws = tokio_tungstenite::accept_async(tcp).await.unwrap();
            drop(ws);
        });
        let mut conn = ws_conn(addr).await;
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        assert!(
            !conn
                .is_alive_within(std::time::Duration::from_secs(2))
                .await
        );
    }

    #[tokio::test]
    async fn ws_health_check_unresponsive_peer_times_out() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let _ws = tokio_tungstenite::accept_async(tcp).await.unwrap();
            // Complete the handshake but never read, so no pong is sent.
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
        });
        let mut conn = ws_conn(addr).await;
        let start = std::time::Instant::now();
        assert!(
            !conn
                .is_alive_within(std::time::Duration::from_millis(300))
                .await
        );
        assert!(start.elapsed() < std::time::Duration::from_secs(5));
    }

    #[tokio::test]
    async fn ws_connect_fails_when_server_does_not_upgrade() {
        use tokio::io::AsyncWriteExt;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut tcp, _) = listener.accept().await.unwrap();
            let _ = tcp
                .write_all(
                    b"HTTP/1.1 200 OK
Content-Length: 0

",
                )
                .await;
        });
        assert!(connect_async(format!("ws://{}", addr)).await.is_err());
    }

    /// Test server: echoes text frames after `reply_delay`, then stays
    /// unresponsive for `pause_after_reply` before reading again, which delays
    /// the automatic pong.
    async fn slow_echo_server(
        reply_delay: std::time::Duration,
        pause_after_reply: std::time::Duration,
    ) -> std::net::SocketAddr {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(tcp).await.unwrap();
            while let Some(Ok(msg)) = ws.next().await {
                if let Message::Text(text) = msg {
                    tokio::time::sleep(reply_delay).await;
                    if ws.send(Message::Text(text)).await.is_err() {
                        break;
                    }
                    tokio::time::sleep(pause_after_reply).await;
                }
            }
        });
        addr
    }

    fn ws_pool(addrs: &[(&str, std::net::SocketAddr)]) -> Arc<McpPool> {
        let configs = addrs
            .iter()
            .map(|(name, addr)| {
                (
                    name.to_string(),
                    McpServerConfig {
                        command: None,
                        args: vec![],
                        env: HashMap::new(),
                        url: Some(format!("ws://{}", addr)),
                    },
                )
            })
            .collect();
        Arc::new(McpPool::new(configs))
    }

    #[tokio::test]
    async fn slow_server_does_not_block_other_servers() {
        let slow = slow_echo_server(
            std::time::Duration::from_millis(1500),
            std::time::Duration::ZERO,
        )
        .await;
        let fast = slow_echo_server(std::time::Duration::ZERO, std::time::Duration::ZERO).await;
        let pool = ws_pool(&[("slow", slow), ("fast", fast)]);

        let slow_pool = pool.clone();
        let slow_task = tokio::spawn(async move {
            let start = std::time::Instant::now();
            let reply = slow_pool.send("slow", "{\"id\":1}", None).await.unwrap();
            (reply, start.elapsed())
        });
        // Let the slow request take its connection lock first.
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;

        let start = std::time::Instant::now();
        let reply = pool.send("fast", "{\"id\":2}", None).await.unwrap();
        let fast_elapsed = start.elapsed();
        assert_eq!(reply, "{\"id\":2}");
        assert!(
            fast_elapsed < std::time::Duration::from_millis(1000),
            "fast server waited for the slow one: {:?}",
            fast_elapsed
        );

        let (slow_reply, slow_elapsed) = slow_task.await.unwrap();
        assert_eq!(slow_reply, "{\"id\":1}");
        assert!(slow_elapsed >= std::time::Duration::from_millis(1400));
    }

    #[tokio::test]
    async fn health_check_runs_pings_in_parallel() {
        let delay = std::time::Duration::from_millis(800);
        let mut servers = Vec::new();
        let names = ["a", "b", "c", "d"];
        for _ in names {
            servers.push(slow_echo_server(std::time::Duration::ZERO, delay).await);
        }
        let pairs: Vec<(&str, std::net::SocketAddr)> =
            names.iter().copied().zip(servers.iter().copied()).collect();
        let pool = ws_pool(&pairs);

        // Open every connection; each server then stalls before it can pong.
        for name in names {
            pool.send(name, "{}", None).await.unwrap();
        }

        let start = std::time::Instant::now();
        let status = pool.health_check().await;
        let elapsed = start.elapsed();

        assert_eq!(status.len(), 4);
        assert!(status.values().all(|alive| *alive), "{:?}", status);
        // Serial pings would take about 4 x 800 ms.
        assert!(
            elapsed < std::time::Duration::from_millis(2000),
            "health_check was not parallel: {:?}",
            elapsed
        );
    }

    #[tokio::test]
    async fn health_check_reports_unconnected_server_as_down() {
        let addr: std::net::SocketAddr = "127.0.0.1:9".parse().unwrap();
        let pool = ws_pool(&[("never", addr)]);
        let status = pool.health_check().await;
        assert_eq!(status.get("never"), Some(&false));
    }

    #[tokio::test]
    async fn health_check_does_not_wait_for_server_with_request_in_flight() {
        // The stuck server reads the request and never answers.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let stuck = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(tcp).await.unwrap();
            while ws.next().await.is_some() {}
        });
        let ok = slow_echo_server(std::time::Duration::ZERO, std::time::Duration::ZERO).await;
        let pool = ws_pool(&[("stuck", stuck), ("ok", ok)]);
        pool.send("ok", "{}", None).await.unwrap();

        let stuck_pool = pool.clone();
        let stuck_task = tokio::spawn(async move { stuck_pool.send("stuck", "{}", None).await });
        // Let the request take the slot of the stuck server.
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;

        let start = std::time::Instant::now();
        let status = pool
            .health_check_with(std::time::Duration::from_millis(300))
            .await;
        let elapsed = start.elapsed();
        stuck_task.abort();

        assert_eq!(status.get("ok"), Some(&true), "{:?}", status);
        assert_eq!(status.get("stuck"), Some(&false), "{:?}", status);
        assert!(
            elapsed < std::time::Duration::from_secs(5),
            "health_check waited for the busy server: {:?}",
            elapsed
        );
    }
}
