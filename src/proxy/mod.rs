//! MCP (Model Context Protocol) Server Pool Module
//!
//! Manages connections to MCP servers with:
//! - Auto-discovery of MCP configurations
//! - Connection pooling and health checks
//! - Support for Stdio and WebSocket transports
//! - Command validation for security
//! - Race-condition-free connection management

use crate::bounded_line::{read_line_bounded_ended, BoundedLine, MAX_STDIN_LINE_BYTES};
use anyhow::{anyhow, Result};
use futures::{future::join_all, SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use tokio::io::{AsyncBufRead, AsyncWriteExt, BufReader, BufWriter};
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
        Err(anyhow!(crate::user_errors::mcp_command_not_allowed(
            "this server",
            command,
            ALLOWED_COMMANDS,
            None
        )))
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
                info!(mcp = %name, url = %url, attempt = attempts, "Connecting to MCP via WebSocket");

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
                            return Err(anyhow!(crate::user_errors::mcp_not_reached(
                                name,
                                url,
                                max_attempts,
                                &e.to_string()
                            )));
                        }
                        warn!(mcp = %name, "Connection failed: {}. Retrying in {:?}...", e, delay);
                        tokio::time::sleep(delay).await;
                        delay *= 2;
                    }
                }
            }
        } else if let Some(command) = &config.command {
            // Validate command before spawning
            validate_command(command).map_err(|_| {
                anyhow!(crate::user_errors::mcp_command_not_allowed(
                    name,
                    command,
                    ALLOWED_COMMANDS,
                    None
                ))
            })?;

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

            let mut child = cmd.spawn().map_err(|e| {
                anyhow!(crate::user_errors::mcp_not_started(
                    name,
                    command,
                    &e.to_string()
                ))
            })?;

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

                read_upstream_line(stdout, MAX_STDIN_LINE_BYTES, request).await
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

/// Read one reply line from an upstream stdio server, holding at most `max` bytes of it.
///
/// A longer line is dropped as it streams past, so a server that never sends a newline cannot make the
/// gateway buffer without a bound. The client then gets a JSON-RPC error carrying the id of its request
/// (`null` when the request has none), and the connection stays usable for the next request.
///
/// A server that closes its output before answering, or in the middle of a reply, is an error: the caller
/// must not receive an empty string or half a JSON message as if it were the answer.
async fn read_upstream_line<R: AsyncBufRead + Unpin>(
    reader: &mut R,
    max: usize,
    request: &str,
) -> Result<String> {
    match read_line_bounded_ended(reader, max).await? {
        (BoundedLine::Line(line), true) => Ok(line.trim().to_string()),
        (BoundedLine::Line(_), false) => Err(anyhow!(
            "The MCP server closed the connection in the middle of a reply"
        )),
        (BoundedLine::Eof, _) => Err(anyhow!(
            "The MCP server closed the connection before it replied"
        )),
        (BoundedLine::TooLong, _) => {
            warn!(
                limit_bytes = max,
                "MCP server reply dropped: line over the size limit"
            );
            let id = serde_json::from_str::<serde_json::Value>(request)
                .ok()
                .and_then(|v| v.get("id").cloned())
                .unwrap_or(serde_json::Value::Null);
            Ok(serde_json::json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": {"code": -32600, "message": "Response too large"}
            })
            .to_string())
        }
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
    /// Plain-English warnings from loading the servers file (servers that were
    /// skipped, a file that could not be read). The caller shows them.
    notices: Vec<String>,
    /// Servers left out when the file was loaded (command not allowed, or
    /// neither a command nor a url), with the reason. A tool call for one of
    /// them is refused instead of being passed on as allowed.
    skipped: HashMap<String, String>,
}

impl McpPool {
    /// Create a new MCP pool with the given configurations
    pub fn new(configs: HashMap<String, McpServerConfig>) -> Self {
        Self {
            configs,
            connections: Mutex::new(HashMap::new()),
            cache: None,
            notices: Vec::new(),
            skipped: HashMap::new(),
        }
    }

    /// Warnings found while loading the servers file, for the user to see.
    pub fn notices(&self) -> &[String] {
        &self.notices
    }

    /// The same pool, with these servers recorded as skipped (name -> reason).
    pub fn with_skipped(mut self, skipped: HashMap<String, String>) -> Self {
        self.skipped = skipped;
        self
    }

    /// The servers that were left out, as (name, reason), sorted by name.
    pub fn skipped_servers(&self) -> Vec<(String, String)> {
        let mut list: Vec<(String, String)> = self
            .skipped
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        list.sort();
        list
    }

    /// If `tool` belongs to a server that was left out, that server and the
    /// reason. The server is read from the tool name: `mcp__<server>__<tool>`,
    /// or `<server>` followed by `__`, `.`, `/` or `:`.
    pub fn skip_reason_for_tool(&self, tool: &str) -> Option<(String, String)> {
        if self.skipped.is_empty() {
            return None;
        }
        let mut candidates: Vec<&str> = Vec::new();
        if let Some(rest) = tool.strip_prefix("mcp__") {
            candidates.extend(rest.split("__").next());
        }
        for sep in ["__", ".", "/", ":"] {
            if let Some((server, _)) = tool.split_once(sep) {
                candidates.push(server);
            }
        }
        candidates
            .into_iter()
            .find_map(|c| self.skipped.get(c).map(|r| (c.to_string(), r.clone())))
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

        let mut notices = Vec::new();
        for path in &search_paths {
            let path_obj = Path::new(path);
            if path_obj.exists() {
                info!("Found MCP config at: {}", path);
                match Self::from_config_file(path) {
                    Ok(mut pool) => {
                        // A broken config at an earlier location is still reported.
                        notices.append(&mut pool.notices);
                        pool.notices = notices;
                        return Ok(pool);
                    }
                    Err(e) => {
                        warn!("Failed to load MCP config from {}: {}", path, e);
                        notices.push(e.to_string());
                        continue;
                    }
                }
            }
        }

        info!("No MCP servers loaded, using an empty pool");
        let mut pool = Self::new(HashMap::new());
        pool.notices = notices;
        Ok(pool)
    }

    /// Load MCP configurations from a JSON file
    fn from_config_file(path: &str) -> Result<Self> {
        let content = std::fs::read_to_string(path).map_err(|e| {
            anyhow!(crate::user_errors::mcp_file_unreadable(
                path,
                &crate::user_errors::plain_text(&e.to_string())
            ))
        })?;

        let value: serde_json::Value = serde_json::from_str(&content).map_err(|e| {
            let at = format!("line {}, column {}", e.line(), e.column());
            let reason = match e.classify() {
                serde_json::error::Category::Eof => {
                    format!("the file ends too early ({at}); a closing }} or ] is probably missing")
                }
                _ => format!("it is not valid JSON at {at}"),
            };
            anyhow!(crate::user_errors::mcp_file_unreadable(path, &reason))
        })?;

        let mut configs = HashMap::new();
        let mut notices = Vec::new();
        let mut skipped = HashMap::new();

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
                    notices.push(crate::user_errors::mcp_server_incomplete(name, Some(path)));
                    skipped.insert(
                        name.clone(),
                        "it has neither a \"command\" nor a \"url\"".to_string(),
                    );
                    continue;
                }

                if let Some(ref cmd) = command {
                    if validate_command(cmd).is_err() {
                        warn!("Skipping MCP server '{}': command not allowed", name);
                        notices.push(crate::user_errors::mcp_command_not_allowed(
                            name,
                            cmd,
                            ALLOWED_COMMANDS,
                            Some(path),
                        ));
                        skipped
                            .insert(name.clone(), format!("\"{cmd}\" is not an allowed command"));
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

        let mut pool = Self::new(configs).with_skipped(skipped);
        pool.notices = notices;
        Ok(pool)
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

    #[tokio::test]
    async fn upstream_normal_reply_passes_unchanged() {
        let mut r = BufReader::new(&b"{\"jsonrpc\":\"2.0\",\"id\":7,\"result\":{}}\r\n"[..]);
        let out = read_upstream_line(&mut r, 1024, r#"{"id":7}"#)
            .await
            .unwrap();
        assert_eq!(out, r#"{"jsonrpc":"2.0","id":7,"result":{}}"#);
    }

    #[tokio::test]
    async fn upstream_line_over_the_cap_becomes_an_error_for_the_request_id() {
        let mut data = vec![b'a'; 2000];
        data.extend_from_slice(b"\n{\"id\":8}\n");
        let mut r = BufReader::new(&data[..]);
        let out = read_upstream_line(&mut r, 1024, r#"{"jsonrpc":"2.0","id":"abc","method":"x"}"#)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["id"], "abc");
        assert_eq!(v["error"]["code"], -32600);
        // The next line is still readable: the proxy stays in sync.
        let next = read_upstream_line(&mut r, 1024, "{}").await.unwrap();
        assert_eq!(next, r#"{"id":8}"#);
    }

    #[tokio::test]
    async fn upstream_request_without_id_gets_a_null_id() {
        let mut r = BufReader::new(&b"aaaaaaaa\n"[..]);
        let out = read_upstream_line(&mut r, 4, "not json").await.unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert!(v["id"].is_null());
    }

    /// 64 MiB with no newline, through a small buffer: dropped as it streams, not stored.
    #[tokio::test]
    async fn upstream_endless_line_is_not_buffered() {
        use tokio::io::AsyncReadExt;
        let stream = tokio::io::repeat(b'a').take(64 * 1024 * 1024);
        let mut r = BufReader::with_capacity(4096, stream);
        let out = read_upstream_line(&mut r, 1024, r#"{"id":1}"#)
            .await
            .unwrap();
        assert!(out.contains("Response too large"));
        assert!(out.len() < 200);
    }

    /// Small chunks that add up past the cap are still refused.
    #[tokio::test]
    async fn upstream_slow_drip_over_the_cap_is_refused() {
        let (mut tx, rx) = tokio::io::duplex(64);
        tokio::spawn(async move {
            for _ in 0..200 {
                if tx.write_all(&[b'a'; 16]).await.is_err() {
                    return;
                }
                tokio::task::yield_now().await;
            }
            let _ = tx.write_all(b"\n").await;
        });
        let mut r = BufReader::with_capacity(32, rx);
        let out = read_upstream_line(&mut r, 1000, r#"{"id":3}"#)
            .await
            .unwrap();
        assert!(out.contains("Response too large"));
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

    #[test]
    fn skipped_servers_are_recorded_with_a_reason_and_matched_by_tool_name() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("mcp_servers.json");
        std::fs::write(
            &file,
            r#"{"mcpServers":{"bad":{"command":"rm"},"empty":{},"good":{"command":"node"}}}"#,
        )
        .unwrap();
        let pool = McpPool::from_config_file(file.to_str().unwrap()).unwrap();
        let skipped = pool.skipped_servers();
        let names: Vec<&str> = skipped.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(names, vec!["bad", "empty"]);
        assert!(
            skipped[0].1.contains("not an allowed command"),
            "{:?}",
            skipped
        );
        assert_eq!(pool.list_mcps(), vec!["good".to_string()]);
        let (server, _) = pool.skip_reason_for_tool("mcp__bad__run").unwrap();
        assert_eq!(server, "bad");
        assert!(pool.skip_reason_for_tool("bad.run").is_some());
        assert!(pool.skip_reason_for_tool("mcp__good__run").is_none());
        assert!(pool.skip_reason_for_tool("other_tool").is_none());
        // A server that is only unreachable is never recorded: nothing here
        // connects, and the list comes from the file alone.
        assert!(pool.skip_reason_for_tool("good.run").is_none());
    }

    #[test]
    fn a_server_with_a_disallowed_command_is_skipped_with_a_notice() {
        let dir = tempfile::tempdir().expect("temp dir");
        let file = dir.path().join("mcp_servers.json");
        std::fs::write(
            &file,
            r#"{"mcpServers": {"demo": {"command": "/nonexistent/zn-demo-server"}, "ok": {"command": "npx"}, "empty": {}}}"#,
        )
        .expect("write");
        let pool = McpPool::from_config_file(file.to_str().expect("utf8")).expect("loads");
        assert_eq!(pool.list_mcps(), vec!["ok".to_string()]);
        let all = pool.notices().join("\n");
        assert!(all.contains("\"demo\" was skipped"), "{all}");
        assert!(all.contains("/nonexistent/zn-demo-server"), "{all}");
        assert!(all.contains("node, npx"), "{all}");
        assert!(all.contains("\"empty\" was skipped"), "{all}");
    }

    #[test]
    fn a_broken_servers_file_is_reported_not_hidden() {
        let dir = tempfile::tempdir().expect("temp dir");
        let file = dir.path().join("mcp_servers.json");
        std::fs::write(&file, "{").expect("write");
        let err = McpPool::from_config_file(file.to_str().expect("utf8"))
            .err()
            .expect("must fail");
        let msg = err.to_string();
        assert!(
            msg.contains("mcp_servers.json") && msg.contains("ends too early"),
            "{msg}"
        );
    }
}

#[cfg(test)]
mod retry_and_discovery_tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex as StdMutex;
    use std::time::{Duration, Instant};
    use tokio::net::TcpListener;

    /// `auto_discover` reads HOME, which is process-wide: these tests take turns.
    static HOME_LOCK: StdMutex<()> = StdMutex::new(());

    struct HomeGuard {
        home: Option<std::ffi::OsString>,
        profile: Option<std::ffi::OsString>,
        _lock: std::sync::MutexGuard<'static, ()>,
    }

    impl HomeGuard {
        fn set(home: Option<&Path>) -> Self {
            let lock = HOME_LOCK.lock().unwrap_or_else(|e| e.into_inner());
            let guard = HomeGuard {
                home: std::env::var_os("HOME"),
                profile: std::env::var_os("USERPROFILE"),
                _lock: lock,
            };
            std::env::remove_var("USERPROFILE");
            match home {
                Some(p) => std::env::set_var("HOME", p),
                None => std::env::remove_var("HOME"),
            }
            guard
        }
    }

    impl Drop for HomeGuard {
        fn drop(&mut self) {
            match &self.home {
                Some(v) => std::env::set_var("HOME", v),
                None => std::env::remove_var("HOME"),
            }
            match &self.profile {
                Some(v) => std::env::set_var("USERPROFILE", v),
                None => std::env::remove_var("USERPROFILE"),
            }
        }
    }

    fn url_config(url: String) -> McpServerConfig {
        McpServerConfig {
            command: None,
            args: vec![],
            env: HashMap::new(),
            url: Some(url),
        }
    }

    /// A local server that closes every TCP connection before the WebSocket
    /// handshake, so each attempt fails. Returns the address and the arrival times.
    async fn refusing_server() -> (std::net::SocketAddr, Arc<StdMutex<Vec<Instant>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let arrivals = Arc::new(StdMutex::new(Vec::new()));
        let seen = arrivals.clone();
        tokio::spawn(async move {
            while let Ok((tcp, _)) = listener.accept().await {
                seen.lock().unwrap().push(Instant::now());
                drop(tcp);
            }
        });
        (addr, arrivals)
    }

    #[tokio::test]
    async fn websocket_connect_backs_off_by_doubling_and_stops_after_five_attempts() {
        let (addr, arrivals) = refusing_server().await;
        let config = url_config(format!("ws://{addr}"));
        let start = Instant::now();
        let err = McpConnection::connect("flaky", &config)
            .await
            .err()
            .expect("every attempt fails");
        let total = start.elapsed();

        let times = arrivals.lock().unwrap().clone();
        assert_eq!(times.len(), 5, "five attempts, then it gives up");
        // Waits between attempts: 0.5 s, 1 s, 2 s, 4 s (each at least that long).
        let floors = [500u64, 1000, 2000, 4000];
        for (i, floor) in floors.iter().enumerate() {
            let gap = times[i + 1].duration_since(times[i]);
            assert!(
                gap >= Duration::from_millis(floor - 50),
                "gap {i} was {gap:?}, expected at least {floor} ms"
            );
        }
        let g: Vec<Duration> = times.windows(2).map(|w| w[1] - w[0]).collect();
        assert!(
            g[3] > g[0],
            "the wait grows from the first retry to the last"
        );
        // No sleep after the final failure: the four waits add up to 7.5 s, and one more (8 s) would pass 15 s.
        assert!(total < Duration::from_secs(12), "took {total:?}");
        let msg = err.to_string();
        assert!(msg.contains("flaky"), "{msg}");
        assert!(msg.contains('5'), "{msg}");
    }

    #[tokio::test]
    async fn websocket_connect_recovers_when_the_server_comes_up_during_the_retries() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let accepted = Arc::new(AtomicUsize::new(0));
        let count = accepted.clone();
        tokio::spawn(async move {
            while let Ok((tcp, _)) = listener.accept().await {
                let n = count.fetch_add(1, Ordering::SeqCst) + 1;
                if n < 3 {
                    drop(tcp);
                } else {
                    let mut ws = tokio_tungstenite::accept_async(tcp).await.unwrap();
                    while ws.next().await.is_some() {}
                    break;
                }
            }
        });
        let config = url_config(format!("ws://{addr}"));
        let start = Instant::now();
        let mut conn = McpConnection::connect("late", &config)
            .await
            .expect("the third attempt succeeds");
        // Two failed attempts wait 0.5 s and 1 s before the third.
        assert!(start.elapsed() >= Duration::from_millis(1400));
        assert_eq!(
            accepted.load(Ordering::SeqCst),
            3,
            "no attempt after success"
        );
        assert!(matches!(conn, McpConnection::WebSocket { .. }));
        assert!(conn.is_alive_within(Duration::from_secs(2)).await);
    }

    #[tokio::test]
    async fn connect_with_neither_command_nor_url_names_the_server() {
        let config = McpServerConfig {
            command: None,
            args: vec![],
            env: HashMap::new(),
            url: None,
        };
        let err = McpConnection::connect("empty-one", &config)
            .await
            .err()
            .expect("must fail");
        assert!(err.to_string().contains("empty-one"), "{err}");
    }

    #[tokio::test]
    async fn connect_refuses_a_command_that_is_not_allowed() {
        let config = McpServerConfig {
            command: Some("bash".to_string()),
            args: vec!["-c".to_string(), "true".to_string()],
            env: HashMap::new(),
            url: None,
        };
        let err = McpConnection::connect("shelly", &config)
            .await
            .err()
            .expect("must fail");
        let msg = err.to_string();
        assert!(msg.contains("shelly") && msg.contains("bash"), "{msg}");
    }

    fn write_servers(home: &Path, rel: &str, body: &str) {
        let file = home.join(rel);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, body).unwrap();
    }

    #[test]
    fn auto_discover_without_any_config_returns_an_empty_pool() {
        let dir = tempfile::tempdir().unwrap();
        let _home = HomeGuard::set(Some(dir.path()));
        let pool = McpPool::auto_discover().expect("an empty pool, not an error");
        assert!(pool.list_mcps().is_empty());
        assert!(pool.notices().is_empty());
    }

    #[test]
    fn auto_discover_loads_the_first_config_it_finds() {
        let dir = tempfile::tempdir().unwrap();
        write_servers(
            dir.path(),
            ".claude/mcp_servers.json",
            r#"{"mcpServers": {"first": {"command": "npx"}}}"#,
        );
        write_servers(
            dir.path(),
            ".config/claude/mcp_servers.json",
            r#"{"mcpServers": {"second": {"command": "npx"}}}"#,
        );
        let _home = HomeGuard::set(Some(dir.path()));
        let pool = McpPool::auto_discover().unwrap();
        assert_eq!(pool.list_mcps(), vec!["first".to_string()]);
    }

    #[test]
    fn auto_discover_uses_the_second_location_when_the_first_is_missing() {
        let dir = tempfile::tempdir().unwrap();
        write_servers(
            dir.path(),
            ".config/claude/mcp_servers.json",
            r#"{"mcpServers": {"second": {"command": "npx"}}}"#,
        );
        let _home = HomeGuard::set(Some(dir.path()));
        let pool = McpPool::auto_discover().unwrap();
        assert_eq!(pool.list_mcps(), vec!["second".to_string()]);
    }

    #[test]
    fn auto_discover_with_only_a_broken_config_reports_it_and_stays_empty() {
        let dir = tempfile::tempdir().unwrap();
        write_servers(dir.path(), ".claude/mcp_servers.json", "{");
        let _home = HomeGuard::set(Some(dir.path()));
        let pool = McpPool::auto_discover().expect("a broken file is a notice, not an error");
        assert!(pool.list_mcps().is_empty());
        assert_eq!(pool.notices().len(), 1);
        assert!(pool.notices()[0].contains("mcp_servers.json"));
    }

    #[test]
    fn auto_discover_falls_through_a_broken_config_to_the_next_one() {
        let dir = tempfile::tempdir().unwrap();
        write_servers(dir.path(), ".claude/mcp_servers.json", "{");
        write_servers(
            dir.path(),
            ".config/claude/mcp_servers.json",
            r#"{"mcpServers": {"second": {"command": "npx"}}}"#,
        );
        let _home = HomeGuard::set(Some(dir.path()));
        let pool = McpPool::auto_discover().unwrap();
        assert_eq!(pool.list_mcps(), vec!["second".to_string()]);
        assert_eq!(
            pool.notices().len(),
            1,
            "the broken first file is still reported"
        );
    }

    #[test]
    fn auto_discover_keeps_the_notice_of_a_broken_first_config() {
        let dir = tempfile::tempdir().unwrap();
        write_servers(dir.path(), ".claude/mcp_servers.json", "{");
        write_servers(
            dir.path(),
            ".config/claude/mcp_servers.json",
            r#"{"mcpServers": {"second": {"command": "npx"}}}"#,
        );
        let _home = HomeGuard::set(Some(dir.path()));
        let pool = McpPool::auto_discover().unwrap();
        assert!(
            pool.notices()
                .iter()
                .any(|n| n.contains("mcp_servers.json")),
            "the user is never told the first file was ignored"
        );
    }

    #[test]
    fn auto_discover_fails_when_no_home_directory_is_known() {
        let _home = HomeGuard::set(None);
        assert!(McpPool::auto_discover().is_err());
    }
}

#[cfg(test)]
mod process_lifecycle_tests {
    use super::*;
    use std::time::Duration;

    /// Upper bound for anything that talks to a child process: a hang fails the test instead of CI.
    const LIMIT: Duration = Duration::from_secs(30);

    fn python3_available() -> bool {
        std::process::Command::new("python3")
            .arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    /// A stdio server that runs `script` with python3 (an allowed command).
    fn py_config(script: &str) -> McpServerConfig {
        McpServerConfig {
            command: Some("python3".to_string()),
            args: vec!["-c".to_string(), script.to_string()],
            env: HashMap::new(),
            url: None,
        }
    }

    /// Replies to every request line with a fixed result, until stdin closes.
    const ECHO_FOREVER: &str = "import sys\n\
        for line in sys.stdin:\n\
        \x20   sys.stdout.write('{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}\\n')\n\
        \x20   sys.stdout.flush()\n";

    fn child_pid(conn: &McpConnection) -> u32 {
        match conn {
            McpConnection::Stdio { child, .. } => child.id().expect("child still has a pid"),
            McpConnection::WebSocket { .. } => panic!("expected a stdio connection"),
        }
    }

    async fn pool_pids(pool: &McpPool) -> Vec<u32> {
        let mut pids = Vec::new();
        for (_, slot) in pool.snapshot_slots().await {
            if let Some(conn) = slot.lock().await.as_ref() {
                pids.push(child_pid(conn));
            }
        }
        pids
    }

    #[cfg(target_os = "linux")]
    fn process_exists(pid: u32) -> bool {
        Path::new(&format!("/proc/{pid}")).exists()
    }

    #[tokio::test]
    async fn spawning_a_missing_binary_is_an_error_and_does_not_hang() {
        let config = McpServerConfig {
            command: Some("/nonexistent/zn-test-dir/python3".to_string()),
            args: vec![],
            env: HashMap::new(),
            url: None,
        };
        let result = tokio::time::timeout(LIMIT, McpConnection::connect("ghost", &config)).await;
        let err = result
            .expect("connect must not hang")
            .err()
            .expect("a missing binary must fail");
        let msg = err.to_string();
        assert!(msg.contains("ghost"), "{msg}");
        assert!(msg.contains("could not start"), "{msg}");
    }

    #[tokio::test]
    async fn pool_send_to_a_server_that_cannot_start_fails_and_stays_empty() {
        let mut configs = HashMap::new();
        configs.insert(
            "ghost".to_string(),
            McpServerConfig {
                command: Some("/nonexistent/zn-test-dir/python3".to_string()),
                args: vec![],
                env: HashMap::new(),
                url: None,
            },
        );
        let pool = McpPool::new(configs);
        let result = tokio::time::timeout(LIMIT, pool.send("ghost", "{}", None)).await;
        assert!(result.expect("send must not hang").is_err());
        assert!(pool_pids(&pool).await.is_empty());
        assert_eq!(pool.health_check().await.get("ghost"), Some(&false));
        // An unknown server is also an error, not a panic.
        assert!(pool.send("nobody", "{}", None).await.is_err());
    }

    #[test]
    fn env_allowlist_rejects_loader_and_path_overrides_and_accepts_ordinary_names() {
        for blocked in [
            "LD_PRELOAD",
            "LD_LIBRARY_PATH",
            "DYLD_INSERT_LIBRARIES",
            "DYLD_LIBRARY_PATH",
            "PATH",
            "HOME",
            "USERPROFILE",
            "SHELL",
            "COMSPEC",
            // Names are compared without regard to case.
            "ld_preload",
            "Path",
            "home",
        ] {
            assert!(!McpConnection::is_safe_env_var(blocked), "{blocked}");
        }
        for allowed in [
            "MY_API_TOKEN",
            "NODE_ENV",
            "LOG_LEVEL",
            "ZN_TEST_FOO",
            "MY_PATH",
            "HOMEPAGE",
        ] {
            assert!(McpConnection::is_safe_env_var(allowed), "{allowed}");
        }
    }

    #[tokio::test]
    async fn blocked_env_vars_never_reach_the_child_and_ordinary_ones_do() {
        if !python3_available() {
            eprintln!("python3 not found: skipping");
            return;
        }
        let script = "import os, sys, json\n\
            sys.stdin.readline()\n\
            print(json.dumps({'ld': os.environ.get('LD_PRELOAD'), \
            'path_overridden': os.environ.get('PATH') == '/evil', \
            'home_overridden': os.environ.get('HOME') == '/evil', \
            'foo': os.environ.get('ZN_TEST_FOO')}), flush=True)\n";
        let mut config = py_config(script);
        config
            .env
            .insert("LD_PRELOAD".to_string(), "/evil/lib.so".to_string());
        config.env.insert("PATH".to_string(), "/evil".to_string());
        config.env.insert("HOME".to_string(), "/evil".to_string());
        config
            .env
            .insert("ZN_TEST_FOO".to_string(), "bar".to_string());

        let run = async {
            let mut conn = McpConnection::connect("envcheck", &config)
                .await
                .map_err(|e| e.to_string())?;
            let reply = conn
                .send_request("{\"id\":1}")
                .await
                .map_err(|e| e.to_string());
            let _ = conn.shutdown().await;
            reply
        };
        let reply = tokio::time::timeout(LIMIT, run)
            .await
            .expect("must not hang")
            .expect("child answers");
        let v: serde_json::Value = serde_json::from_str(&reply).expect("json reply");
        assert!(v["ld"].is_null(), "LD_PRELOAD reached the child: {v}");
        assert_eq!(v["path_overridden"], false);
        assert_eq!(v["home_overridden"], false);
        assert_eq!(v["foo"], "bar");
    }

    #[tokio::test]
    async fn upstream_closing_before_any_reply_is_an_error() {
        if !python3_available() {
            eprintln!("python3 not found: skipping");
            return;
        }
        let config = py_config("import sys\nsys.stdin.readline()\n");
        let run = async {
            let mut conn = McpConnection::connect("quitter", &config).await.unwrap();
            let result = conn.send_request("{\"id\":1}").await;
            let _ = conn.shutdown().await;
            result
        };
        let result = tokio::time::timeout(LIMIT, run).await.expect("no hang");
        let err = result.expect_err("a closed upstream is not an empty reply");
        assert!(err.to_string().contains("closed"), "{err}");
    }

    #[tokio::test]
    async fn upstream_closing_in_the_middle_of_a_reply_is_an_error() {
        if !python3_available() {
            eprintln!("python3 not found: skipping");
            return;
        }
        let script = "import sys\n\
            sys.stdin.readline()\n\
            sys.stdout.write('{\"jsonrpc\":\"2.0\",\"id\":1,\"res')\n\
            sys.stdout.flush()\n";
        let config = py_config(script);
        let run = async {
            let mut conn = McpConnection::connect("cutoff", &config).await.unwrap();
            let result = conn.send_request("{\"id\":1}").await;
            let _ = conn.shutdown().await;
            result
        };
        let result = tokio::time::timeout(LIMIT, run).await.expect("no hang");
        let err = result.expect_err("half a reply must not be passed on as a reply");
        assert!(err.to_string().contains("closed"), "{err}");
    }

    #[tokio::test]
    async fn upstream_reply_helper_tells_complete_lines_from_cut_ones() {
        // Complete line, with and without a carriage return.
        for data in [&b"{\"id\":1}\n"[..], &b"{\"id\":1}\r\n"[..]] {
            let mut r = BufReader::new(data);
            assert_eq!(
                read_upstream_line(&mut r, 1024, "{}").await.unwrap(),
                "{\"id\":1}"
            );
        }
        // Nothing at all, and a line with no end.
        let mut r = BufReader::new(&b""[..]);
        assert!(read_upstream_line(&mut r, 1024, "{}").await.is_err());
        let mut r = BufReader::new(&b"{\"id\":1,\"res"[..]);
        assert!(read_upstream_line(&mut r, 1024, "{}").await.is_err());
        // An oversized line still becomes a JSON-RPC error for the caller, not a transport error.
        let mut r = BufReader::new(&b"aaaaaaaaaa"[..]);
        let out = read_upstream_line(&mut r, 4, r#"{"id":9}"#).await.unwrap();
        assert!(out.contains("Response too large"), "{out}");
    }

    #[tokio::test]
    async fn stdio_request_reply_round_trip_through_the_pool() {
        if !python3_available() {
            eprintln!("python3 not found: skipping");
            return;
        }
        let mut configs = HashMap::new();
        configs.insert("echo".to_string(), py_config(ECHO_FOREVER));
        let pool = McpPool::new(configs);
        let run = async {
            let first = pool.send("echo", "{\"id\":1}", None).await.unwrap();
            let second = pool.send("echo", "{\"id\":2}", None).await.unwrap();
            (first, second)
        };
        let (first, second) = tokio::time::timeout(LIMIT, run).await.expect("no hang");
        assert_eq!(first, "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}");
        assert_eq!(first, second);
        assert_eq!(pool_pids(&pool).await.len(), 1, "one process is reused");
        pool.shutdown_all().await;
    }

    #[tokio::test]
    async fn shutdown_all_kills_every_child_and_can_be_repeated() {
        if !python3_available() {
            eprintln!("python3 not found: skipping");
            return;
        }
        let mut configs = HashMap::new();
        configs.insert("one".to_string(), py_config(ECHO_FOREVER));
        configs.insert("two".to_string(), py_config(ECHO_FOREVER));
        let pool = McpPool::new(configs);

        let run = async {
            pool.send("one", "{\"id\":1}", None).await.unwrap();
            pool.send("two", "{\"id\":1}", None).await.unwrap();
            let pids = pool_pids(&pool).await;
            assert_eq!(pids.len(), 2);
            let health = pool.health_check().await;
            assert_eq!(health.get("one"), Some(&true));
            assert_eq!(health.get("two"), Some(&true));

            pool.shutdown_all().await;
            pids
        };
        let pids = tokio::time::timeout(LIMIT, run).await.expect("no hang");

        #[cfg(target_os = "linux")]
        for pid in &pids {
            assert!(!process_exists(*pid), "child {pid} survived shutdown_all");
        }
        assert!(pool_pids(&pool).await.is_empty());

        // Calling it again, and on a pool that never connected, is harmless.
        pool.shutdown_all().await;
        McpPool::new(HashMap::new()).shutdown_all().await;
        let health = pool.health_check().await;
        assert_eq!(health.get("one"), Some(&false));
        assert_eq!(health.get("two"), Some(&false));

        // The pool starts a fresh process on the next request.
        let reply = tokio::time::timeout(LIMIT, pool.send("one", "{\"id\":3}", None))
            .await
            .expect("no hang")
            .unwrap();
        assert!(reply.contains("\"result\""));
        let fresh = pool_pids(&pool).await;
        assert_eq!(fresh.len(), 1);
        assert!(!pids.contains(&fresh[0]));
        pool.shutdown_all().await;
    }

    #[tokio::test]
    async fn connection_shutdown_is_idempotent_and_leaves_it_not_alive() {
        if !python3_available() {
            eprintln!("python3 not found: skipping");
            return;
        }
        let run = async {
            let mut conn = McpConnection::connect("echo", &py_config(ECHO_FOREVER))
                .await
                .unwrap();
            assert!(conn.is_alive().await);
            conn.shutdown().await.unwrap();
            assert!(!conn.is_alive().await);
            conn.shutdown().await.unwrap();
            assert!(!conn.is_alive().await);
        };
        tokio::time::timeout(LIMIT, run).await.expect("no hang");
    }

    fn load(body: &str) -> Result<McpPool> {
        let dir = tempfile::tempdir().expect("temp dir");
        let file = dir.path().join("mcp_servers.json");
        std::fs::write(&file, body).expect("write");
        McpPool::from_config_file(file.to_str().expect("utf8"))
    }

    #[test]
    fn config_with_a_repeated_server_name_keeps_one_entry_and_does_not_panic() {
        // JSON parsers keep the last value of a repeated key; the loader must not crash or list it twice.
        let pool = load(
            r#"{"mcpServers": {"dup": {"command": "node", "args": ["first.js"]}, "dup": {"command": "python3", "args": ["second.py"]}}}"#,
        )
        .expect("loads");
        assert_eq!(pool.list_mcps(), vec!["dup".to_string()]);
        let cfg = &pool.configs["dup"];
        assert_eq!(cfg.command.as_deref(), Some("python3"));
        assert_eq!(cfg.args, vec!["second.py".to_string()]);
    }

    #[test]
    fn config_with_an_empty_command_skips_that_server_with_a_notice() {
        for command in ["", "   ", "\t"] {
            let body = format!(
                r#"{{"mcpServers": {{"blank": {{"command": {command:?}}}, "ok": {{"command": "npx"}}}}}}"#
            );
            let pool = load(&body).expect("one bad server does not fail the file");
            assert_eq!(pool.list_mcps(), vec!["ok".to_string()], "{command:?}");
            assert!(pool.skip_reason_for_tool("blank.run").is_some());
            let notices = pool.notices().join("\n");
            assert!(notices.contains("\"blank\" was skipped"), "{notices}");
        }
    }

    #[test]
    fn config_that_cannot_be_read_is_an_error_naming_the_path() {
        let dir = tempfile::tempdir().expect("temp dir");

        let missing = dir.path().join("missing.json");
        let err = McpPool::from_config_file(missing.to_str().unwrap())
            .err()
            .expect("missing file must fail");
        assert!(err.to_string().contains("missing.json"), "{err}");

        // A directory where the file should be.
        let as_dir = dir.path().join("dir.json");
        std::fs::create_dir(&as_dir).unwrap();
        let err = McpPool::from_config_file(as_dir.to_str().unwrap())
            .err()
            .expect("a directory is not a servers file");
        assert!(err.to_string().contains("dir.json"), "{err}");

        // Bytes that are not text.
        let binary = dir.path().join("binary.json");
        std::fs::write(&binary, [0xff, 0xfe, 0x00, 0x80]).unwrap();
        let err = McpPool::from_config_file(binary.to_str().unwrap())
            .err()
            .expect("binary content must fail");
        assert!(err.to_string().contains("binary.json"), "{err}");
    }

    #[test]
    fn config_with_unexpected_shapes_loads_without_servers_or_panics() {
        for body in [
            "[]",
            "null",
            "42",
            r#"{}"#,
            r#"{"mcpServers": []}"#,
            r#"{"mcpServers": "x"}"#,
            r#"{"mcpServers": {"s": "not an object"}}"#,
            r#"{"mcpServers": {"s": {"command": 5}}}"#,
        ] {
            let pool = load(body).unwrap_or_else(|e| panic!("{body}: {e}"));
            assert!(pool.list_mcps().is_empty(), "{body}");
        }

        // Entries of the wrong type inside a valid server are dropped, the server stays.
        let pool = load(
            r#"{"mcpServers": {"s": {"command": "npx", "args": ["a", 1, null, "b"], "env": {"K": "v", "N": 1}}}}"#,
        )
        .unwrap();
        let cfg = &pool.configs["s"];
        assert_eq!(cfg.args, vec!["a".to_string(), "b".to_string()]);
        assert_eq!(cfg.env.len(), 1);
        assert_eq!(cfg.env.get("K").map(String::as_str), Some("v"));
    }
}
