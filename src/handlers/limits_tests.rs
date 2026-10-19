//! Message and frame size limits on the MCP WebSocket upgrade.

use super::websocket::apply_limits;
use crate::config::ServerConfig;
use axum::{
    extract::{
        ws::{Message, WebSocketUpgrade},
        State,
    },
    response::IntoResponse,
    routing::get,
    Router,
};
use futures::{SinkExt, StreamExt};
use std::time::Duration;
use tokio_tungstenite::tungstenite::Message as ClientMessage;

async fn echo_handler(State(cfg): State<ServerConfig>, ws: WebSocketUpgrade) -> impl IntoResponse {
    apply_limits(ws, &cfg).on_upgrade(|mut socket| async move {
        while let Some(Ok(msg)) = socket.recv().await {
            if let Message::Text(t) = msg {
                if socket.send(Message::Text(t)).await.is_err() {
                    break;
                }
            }
        }
    })
}

async fn spawn_server(cfg: ServerConfig) -> std::net::SocketAddr {
    let app = Router::new()
        .route("/ws", get(echo_handler))
        .with_state(cfg);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    addr
}

/// Send `len` bytes of text; return true when the server echoed it back.
async fn echoed(addr: std::net::SocketAddr, len: usize) -> bool {
    let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{}/ws", addr))
        .await
        .unwrap();
    let payload = "a".repeat(len);
    // The send may fail when the server has already closed the socket.
    let _ = ws.send(ClientMessage::Text(payload.clone().into())).await;
    let result = tokio::time::timeout(Duration::from_secs(5), async {
        while let Some(item) = ws.next().await {
            match item {
                Ok(ClientMessage::Text(t)) => return t.as_str() == payload,
                Ok(ClientMessage::Close(_)) | Err(_) => return false,
                Ok(_) => continue,
            }
        }
        false
    })
    .await;
    result.expect("server neither echoed nor closed the socket in time")
}

fn small_limits(message: usize, frame: usize) -> ServerConfig {
    ServerConfig {
        ws_max_message_bytes: message,
        ws_max_frame_bytes: frame,
        ..ServerConfig::default()
    }
}

#[test]
fn defaults_are_one_mib_message_and_frame() {
    let cfg = ServerConfig::default();
    assert_eq!(cfg.ws_max_message_bytes, 1024 * 1024);
    assert_eq!(cfg.ws_max_frame_bytes, 1024 * 1024);
}

#[test]
fn limits_can_be_set_in_the_config_file() {
    let cfg: ServerConfig =
        serde_json::from_str(r#"{"ws_max_message_bytes": 2048, "ws_max_frame_bytes": 512}"#)
            .unwrap();
    assert_eq!(cfg.ws_max_message_bytes, 2048);
    assert_eq!(cfg.ws_max_frame_bytes, 512);
    let missing: ServerConfig = serde_json::from_str("{}").unwrap();
    assert_eq!(missing.ws_max_message_bytes, 1024 * 1024);
}

#[tokio::test]
async fn message_under_the_limit_is_echoed() {
    let addr = spawn_server(small_limits(2048, 1024)).await;
    assert!(echoed(addr, 512).await);
}

#[tokio::test]
async fn frame_over_the_frame_limit_closes_the_socket() {
    let addr = spawn_server(small_limits(8192, 1024)).await;
    assert!(!echoed(addr, 2000).await);
}

#[tokio::test]
async fn message_over_the_message_limit_closes_the_socket() {
    let addr = spawn_server(small_limits(1024, 8192)).await;
    assert!(!echoed(addr, 2000).await);
}

#[tokio::test]
async fn default_limits_pass_100_kib_and_reject_2_mib() {
    let addr = spawn_server(ServerConfig::default()).await;
    assert!(echoed(addr, 100 * 1024).await);
    assert!(!echoed(addr, 2 * 1024 * 1024).await);
}
