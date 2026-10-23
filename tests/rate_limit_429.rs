//! The management API's rate limiter: with a burst of 1, the second request from the same peer
//! address is refused with 429 and a `retry-after` header, and a different peer address is not.

use axum::{routing::get, Router};
use std::net::SocketAddr;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpSocket};
use tower_governor::governor::GovernorConfigBuilder;
use tower_governor::GovernorLayer;
use zn::http_limits::{serve_limited, ServeLimits};

async fn get_status(server: SocketAddr, from: &str) -> (u16, String) {
    let socket = TcpSocket::new_v4().unwrap();
    socket.bind(format!("{from}:0").parse().unwrap()).unwrap();
    let mut stream = socket.connect(server).await.unwrap();
    stream
        .write_all(b"GET /ping HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
        .await
        .unwrap();
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).await.unwrap();
    let text = String::from_utf8_lossy(&raw).to_string();
    let status = text
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .expect("a status line");
    (status, text.to_lowercase())
}

#[tokio::test]
async fn second_request_from_the_same_ip_is_429_and_another_ip_is_not() {
    let conf = GovernorConfigBuilder::default()
        .per_second(1)
        .burst_size(1)
        .finish()
        .unwrap();
    let app = Router::new()
        .route("/ping", get(|| async { "ok" }))
        .layer(GovernorLayer::new(conf));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let server = listener.local_addr().unwrap();
    tokio::spawn(serve_limited(listener, app, ServeLimits::default()));

    let (first, _) = get_status(server, "127.0.0.1").await;
    assert_eq!(first, 200);
    let (second, headers) = get_status(server, "127.0.0.1").await;
    assert_eq!(second, 429, "{headers}");
    assert!(headers.contains("retry-after:"), "{headers}");

    // Loopback answers on all of 127.0.0.0/8 on Linux; other systems may not allow the bind.
    if cfg!(target_os = "linux") {
        let (other, headers) = get_status(server, "127.0.0.2").await;
        assert_eq!(other, 200, "{headers}");
    }
}
