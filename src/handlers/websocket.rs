//! WebSocket Handler for MCP Protocol
//!
//! Handles bidirectional WebSocket connections for MCP tool calls.

use axum::{
    extract::{ws::WebSocketUpgrade, State},
    response::IntoResponse,
    Extension,
};
use futures::{SinkExt, StreamExt};
use std::sync::Arc;
use tokio::sync::broadcast;

use crate::audit::{AuditEntry, AuditVault};
use crate::config::ZnConfig;
use crate::engine::reputation::ReputationSystem;
use crate::engine::ZnEngine;
use crate::proxy::McpPool;
use crate::shield;
use crate::tenants::TenantContext;
use crate::webhooks;

/// WebSocket handler state
#[derive(Clone)]
pub struct WsState {
    pub tx: broadcast::Sender<AuditEntry>,
    pub vault: Arc<AuditVault>,
    pub reputation: Arc<ReputationSystem>,
    pub engine: Arc<ZnEngine>,
    pub pool: Arc<McpPool>,
    pub config: Arc<ZnConfig>,
    pub webhook_tx: tokio::sync::mpsc::Sender<webhooks::AlertPayload>,
}

/// Apply the configured message and frame size limits to a WebSocket upgrade.
/// A message or frame over the limit closes the connection (the library
/// defaults are 64 MiB and 16 MiB).
pub fn apply_limits(
    ws: WebSocketUpgrade,
    server: &crate::config::ServerConfig,
) -> WebSocketUpgrade {
    ws.max_message_size(server.ws_max_message_bytes)
        .max_frame_size(server.ws_max_frame_bytes)
}

/// MCP WebSocket handler with security checks
pub async fn mcp_handler(
    State(state): State<WsState>,
    ws: WebSocketUpgrade,
    Extension(tenant): Extension<TenantContext>,
    header_map: axum::http::HeaderMap,
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> impl IntoResponse {
    // 1. WebSocket Origin Guard
    let origin = header_map
        .get("origin")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("");
    if !shield::McpShield::validate_origin(origin, &state.config.security.allowed_origins) {
        tracing::warn!("Blocked Unauthorized WebSocket Origin: {}", origin);
        return (axum::http::StatusCode::FORBIDDEN, "Origin not allowed").into_response();
    }

    // 2. Token-Based Auth (Optional additional check)
    let provided_token = params.get("token").cloned().or_else(|| {
        header_map
            .get("x-mcp-token")
            .and_then(|h| h.to_str().ok())
            .map(|s| s.to_string())
    });

    if !crate::auth::mcp_ws_token_matches(
        state.config.security.mcp_ws_token.as_deref(),
        provided_token.as_deref(),
    ) {
        tracing::warn!("Blocked Unauthorized WebSocket Connection: Invalid or missing token");
        return (
            axum::http::StatusCode::UNAUTHORIZED,
            "Invalid security token",
        )
            .into_response();
    }

    let namespace = tenant.namespace.clone();
    apply_limits(ws, &state.config.server)
        .on_upgrade(move |socket| handle_socket(socket, state, namespace))
}

/// Handle individual WebSocket connection
async fn handle_socket(socket: axum::extract::ws::WebSocket, _state: WsState, _namespace: String) {
    use axum::extract::ws::Message;

    let (mut sender, mut receiver) = socket.split();

    while let Some(Ok(msg)) = receiver.next().await {
        if let Message::Text(text) = msg {
            // For now, echo back - full MCP processing would go here
            // In production, this calls process_mcp_message from main.rs
            let response = serde_json::json!({
                "jsonrpc": "2.0",
                "id": null,
                "result": { "echo": text.chars().take(50).collect::<String>() },
            })
            .to_string();

            if let Err(e) = sender.send(Message::Text(response.into())).await {
                tracing::error!("WS send error: {}", e);
                break;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::ZnEngineConfig;
    use crate::tenants::TenantRole;
    use axum::{routing::get, Router};
    use futures::{SinkExt, StreamExt};
    use std::net::SocketAddr;
    use std::time::Duration;
    use tokio::net::TcpListener;
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    use tokio_tungstenite::tungstenite::{Error as WsError, Message};

    const TOKEN: &str = "test-token-not-a-secret";
    const ALLOWED_ORIGIN: &str = "http://localhost:5173";

    fn test_config(token: Option<&str>) -> ZnConfig {
        let mut config = ZnConfig::default();
        config.security.mcp_ws_token = token.map(|t| t.to_string());
        config
    }

    fn test_state(config: ZnConfig) -> WsState {
        let (tx, _rx) = broadcast::channel(16);
        let (webhook_tx, _webhook_rx) = tokio::sync::mpsc::channel(4);
        WsState {
            tx,
            vault: Arc::new(AuditVault::new(":memory:", None).expect("vault init")),
            reputation: Arc::new(ReputationSystem::new()),
            engine: Arc::new(
                ZnEngine::new(ZnEngineConfig {
                    gas_limit: 10_000_000,
                    memory_limit: 10 * 1024 * 1024,
                    timeout_ms: 50,
                    allowed_hashes: vec![],
                    signing_public_key: None,
                })
                .expect("engine init"),
            ),
            pool: Arc::new(McpPool::new(std::collections::HashMap::new())),
            config: Arc::new(config),
            webhook_tx,
        }
    }

    /// Serve the handler on a loopback port picked by the OS.
    async fn spawn_server(config: ZnConfig) -> SocketAddr {
        let tenant = TenantContext {
            id: "ws-test-1".to_string(),
            name: "WebSocket Test Tenant".to_string(),
            namespace: "ws-test-ns".to_string(),
            role: TenantRole::User,
        };
        let app = Router::new()
            .route("/ws", get(mcp_handler))
            .layer(Extension(tenant))
            .with_state(test_state(config));
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("local addr");
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        addr
    }

    type Client = tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >;

    async fn connect(
        addr: SocketAddr,
        query: &str,
        origin: Option<&str>,
        token_header: Option<&str>,
    ) -> Result<Client, WsError> {
        let mut request = format!("ws://{addr}/ws{query}")
            .into_client_request()
            .expect("request");
        if let Some(origin) = origin {
            request
                .headers_mut()
                .insert("origin", origin.parse().unwrap());
        }
        if let Some(token) = token_header {
            request
                .headers_mut()
                .insert("x-mcp-token", token.parse().unwrap());
        }
        let (client, _resp) = tokio_tungstenite::connect_async(request).await?;
        Ok(client)
    }

    fn rejected_status(result: Result<Client, WsError>) -> u16 {
        match result {
            Err(WsError::Http(resp)) => resp.status().as_u16(),
            Err(other) => panic!("expected an HTTP rejection, got {other:?}"),
            Ok(_) => panic!("expected the upgrade to be rejected"),
        }
    }

    async fn next_text(client: &mut Client) -> String {
        let msg = tokio::time::timeout(Duration::from_secs(5), client.next())
            .await
            .expect("timed out waiting for a message")
            .expect("stream ended")
            .expect("ws error");
        msg.to_text().expect("text frame").to_string()
    }

    async fn echo_of(client: &mut Client, text: &str) -> serde_json::Value {
        client.send(Message::text(text)).await.expect("send");
        let reply = next_text(client).await;
        serde_json::from_str(&reply).expect("reply must be valid JSON")
    }

    #[tokio::test]
    async fn text_message_gets_a_jsonrpc_echo() {
        let addr = spawn_server(test_config(None)).await;
        let mut client = connect(addr, "", Some(ALLOWED_ORIGIN), None).await.unwrap();

        let reply = echo_of(&mut client, "hello").await;
        assert_eq!(reply["jsonrpc"], "2.0");
        assert!(reply["id"].is_null());
        assert_eq!(reply["result"]["echo"], "hello");
    }

    #[tokio::test]
    async fn several_messages_are_answered_in_order() {
        let addr = spawn_server(test_config(None)).await;
        let mut client = connect(addr, "", Some(ALLOWED_ORIGIN), None).await.unwrap();

        for i in 0..5 {
            let text = format!("msg-{i}");
            let reply = echo_of(&mut client, &text).await;
            assert_eq!(reply["result"]["echo"], text.as_str());
        }
    }

    #[tokio::test]
    async fn echo_is_truncated_to_50_characters() {
        let addr = spawn_server(test_config(None)).await;
        let mut client = connect(addr, "", Some(ALLOWED_ORIGIN), None).await.unwrap();

        // Multi-byte characters: the cut is by character, never inside one.
        let reply = echo_of(&mut client, &"é".repeat(80)).await;
        assert_eq!(reply["result"]["echo"], "é".repeat(50).as_str());
    }

    #[tokio::test]
    async fn echo_stays_valid_json_for_quotes_and_backslashes() {
        let addr = spawn_server(test_config(None)).await;
        let mut client = connect(addr, "", Some(ALLOWED_ORIGIN), None).await.unwrap();

        let text = r#"a "quoted" word \ and {"k":1}"#;
        let reply = echo_of(&mut client, text).await;
        assert_eq!(reply["result"]["echo"], text);
    }

    #[tokio::test]
    async fn one_megabyte_message_is_accepted_and_truncated() {
        // The handler sets no message size limit of its own; the axum default
        // (64 MiB per message) applies. A 1 MiB message is well inside it.
        let addr = spawn_server(test_config(None)).await;
        let mut client = connect(addr, "", Some(ALLOWED_ORIGIN), None).await.unwrap();

        let reply = echo_of(&mut client, &"x".repeat(1024 * 1024)).await;
        assert_eq!(reply["result"]["echo"], "x".repeat(50).as_str());
    }

    #[tokio::test]
    async fn binary_frames_get_no_reply_and_the_socket_stays_usable() {
        let addr = spawn_server(test_config(None)).await;
        let mut client = connect(addr, "", Some(ALLOWED_ORIGIN), None).await.unwrap();

        client
            .send(Message::binary(vec![0u8, 1, 2, 3]))
            .await
            .unwrap();
        // The next reply belongs to the text message, not to the binary frame.
        let reply = echo_of(&mut client, "after-binary").await;
        assert_eq!(reply["result"]["echo"], "after-binary");
    }

    #[tokio::test]
    async fn client_close_ends_the_session_cleanly() {
        let addr = spawn_server(test_config(None)).await;
        let mut client = connect(addr, "", Some(ALLOWED_ORIGIN), None).await.unwrap();
        let _ = echo_of(&mut client, "ping").await;

        client.send(Message::Close(None)).await.unwrap();
        // The server answers with a close frame and the stream then ends.
        let end = tokio::time::timeout(Duration::from_secs(5), async {
            while let Some(msg) = client.next().await {
                match msg {
                    Ok(Message::Close(_)) => continue,
                    Ok(other) => panic!("unexpected frame after close: {other:?}"),
                    Err(_) => break,
                }
            }
        })
        .await;
        assert!(
            end.is_ok(),
            "the connection did not end after a close frame"
        );
    }

    #[tokio::test]
    async fn dropping_the_client_does_not_break_the_server() {
        let addr = spawn_server(test_config(None)).await;
        let client = connect(addr, "", Some(ALLOWED_ORIGIN), None).await.unwrap();
        drop(client);

        let mut second = connect(addr, "", Some(ALLOWED_ORIGIN), None).await.unwrap();
        let reply = echo_of(&mut second, "still-up").await;
        assert_eq!(reply["result"]["echo"], "still-up");
    }

    #[tokio::test]
    async fn foreign_origin_is_rejected_with_403() {
        let addr = spawn_server(test_config(None)).await;
        let status =
            rejected_status(connect(addr, "", Some("https://app.example.com"), None).await);
        assert_eq!(status, 403);
    }

    #[tokio::test]
    async fn missing_origin_is_rejected_when_an_allow_list_is_set() {
        let addr = spawn_server(test_config(None)).await;
        let status = rejected_status(connect(addr, "", None, None).await);
        assert_eq!(status, 403);
    }

    #[tokio::test]
    async fn token_is_required_when_configured() {
        let addr = spawn_server(test_config(Some(TOKEN))).await;

        let missing = rejected_status(connect(addr, "", Some(ALLOWED_ORIGIN), None).await);
        assert_eq!(missing, 401);

        let wrong = rejected_status(
            connect(addr, "?token=not-the-token", Some(ALLOWED_ORIGIN), None).await,
        );
        assert_eq!(wrong, 401);

        let wrong_header =
            rejected_status(connect(addr, "", Some(ALLOWED_ORIGIN), Some("not-the-token")).await);
        assert_eq!(wrong_header, 401);
    }

    #[tokio::test]
    async fn token_is_accepted_in_query_and_in_header() {
        let addr = spawn_server(test_config(Some(TOKEN))).await;

        let mut by_query = connect(addr, &format!("?token={TOKEN}"), Some(ALLOWED_ORIGIN), None)
            .await
            .unwrap();
        assert_eq!(echo_of(&mut by_query, "q").await["result"]["echo"], "q");

        let mut by_header = connect(addr, "", Some(ALLOWED_ORIGIN), Some(TOKEN))
            .await
            .unwrap();
        assert_eq!(echo_of(&mut by_header, "h").await["result"]["echo"], "h");
    }

    #[tokio::test]
    async fn origin_is_checked_before_the_token() {
        let addr = spawn_server(test_config(Some(TOKEN))).await;
        let status = rejected_status(
            connect(
                addr,
                &format!("?token={TOKEN}"),
                Some("https://app.example.com"),
                None,
            )
            .await,
        );
        assert_eq!(status, 403);
    }
}
