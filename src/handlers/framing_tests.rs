//! Malformed HTTP framing against the management API stack: the same `axum::serve` (hyper) the gateway
//! uses, with an extractor of the same shape as the real POST handlers (`axum::Json<CreateTenantRequest>`),
//! plus the JSON-RPC validator that reads every frame.
//!
//! Each case sends raw bytes over a TCP socket and records the status line and the time to answer. A case
//! must end in a clean 4xx, a close, or (when RFC 9112 allows it) a normal answer, within a bounded time:
//! never a hang, a panic or an unintended 2xx. Run with `--nocapture` to see the `FRAMING` lines.
//!
//! Cases that expose a real gap keep their test, marked `#[ignore = "B-xxxx: ..."]`.

use crate::handlers::api::CreateTenantRequest;
use crate::http_limits::{serve_limited, ServeLimits};
use crate::jsonrpc::{validate_jsonrpc, JsonRpcValidation};
use axum::{
    extract::ws::WebSocketUpgrade,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use futures::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::net::SocketAddr;
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

const BOUND: Duration = Duration::from_secs(2);

async fn health() -> &'static str {
    "OK"
}

async fn tenants(Json(p): Json<CreateTenantRequest>) -> Json<Value> {
    Json(json!({ "name_len": p.name.len() }))
}

/// Short limits so the stall tests finish fast; the headers and body limits are well under `BOUND`.
const TEST_LIMITS: ServeLimits = ServeLimits {
    header_read_timeout: Duration::from_millis(300),
    body_idle_timeout: Duration::from_millis(300),
    max_connections: 64,
};

async fn spawn_server() -> SocketAddr {
    spawn_server_with(TEST_LIMITS).await
}

/// The same serve function the gateway runs, with the given limits.
async fn spawn_server_with(limits: ServeLimits) -> SocketAddr {
    let app = Router::new()
        .route("/api/v1/health", get(health))
        .route("/api/v1/tenants", post(tenants))
        .route("/ws", get(ws_echo));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { serve_limited(listener, app, limits).await });
    addr
}

async fn ws_echo(ws: WebSocketUpgrade) -> impl IntoResponse {
    ws.on_upgrade(|mut socket| async move {
        while let Some(Ok(msg)) = socket.recv().await {
            if socket.send(msg).await.is_err() {
                break;
            }
        }
    })
}

#[derive(Debug)]
struct Probe {
    /// None when the server closed without a status line.
    status: Option<u16>,
    elapsed: Duration,
    /// True when nothing came back before `wait` (a hang from the client's side).
    timed_out: bool,
}

fn report(case: &str, p: &Probe) {
    println!(
        "FRAMING case={case} status={} ms={} timed_out={}",
        p.status.map_or("none".to_string(), |s| s.to_string()),
        p.elapsed.as_millis(),
        p.timed_out
    );
}

/// Send `raw`, then read until the response head is complete, the peer closes, or `wait` runs out.
async fn probe(addr: SocketAddr, raw: Vec<u8>, wait: Duration) -> Probe {
    let mut s = TcpStream::connect(addr).await.unwrap();
    let start = Instant::now();
    // The server may close while a large request is still being written: that is a clean block.
    let _ = s.write_all(&raw).await;
    let mut buf: Vec<u8> = Vec::new();
    let mut tmp = [0u8; 4096];
    let read = tokio::time::timeout(wait, async {
        loop {
            match s.read(&mut tmp).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    buf.extend_from_slice(&tmp[..n]);
                    if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                        break;
                    }
                }
            }
        }
    })
    .await;
    let status = std::str::from_utf8(&buf)
        .ok()
        .and_then(|t| t.split_whitespace().nth(1))
        .and_then(|c| c.parse::<u16>().ok());
    Probe {
        status,
        elapsed: start.elapsed(),
        timed_out: read.is_err(),
    }
}

/// A POST with the given extra header lines (each ending in CRLF) and body.
fn post_with(extra: &str, body: &str) -> Vec<u8> {
    format!(
        "POST /api/v1/tenants HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\n{extra}\r\n{body}"
    )
    .into_bytes()
}

const BODY: &str = r#"{"name":"example","namespace":"example-ns","api_key":"example-key-0000"}"#;

fn is_clean_reject(p: &Probe) -> bool {
    !p.timed_out && p.elapsed < BOUND && p.status.is_none_or(|s| (400..500).contains(&s))
}

#[tokio::test]
async fn duplicate_equal_content_length_is_merged_or_rejected_never_hangs() {
    let addr = spawn_server().await;
    let l = BODY.len();
    let raw = post_with(
        &format!("Content-Length: {l}\r\nContent-Length: {l}\r\n"),
        BODY,
    );
    let p = probe(addr, raw, BOUND).await;
    report("dup_content_length_equal", &p);
    // RFC 9112 6.3 lets a recipient merge identical values or reject; both are fine.
    assert!(!p.timed_out && p.elapsed < BOUND, "{p:?}");
    assert!(
        matches!(p.status, Some(200)) || is_clean_reject(&p),
        "{p:?}"
    );
}

#[tokio::test]
async fn duplicate_conflicting_content_length_is_400() {
    let addr = spawn_server().await;
    let l = BODY.len();
    let raw = post_with(
        &format!("Content-Length: {l}\r\nContent-Length: {}\r\n", l + 5),
        BODY,
    );
    let p = probe(addr, raw, BOUND).await;
    report("dup_content_length_conflict", &p);
    assert!(is_clean_reject(&p), "{p:?}");
    assert_ne!(p.status, Some(200));
}

#[tokio::test]
async fn comma_list_conflicting_content_length_is_400() {
    let addr = spawn_server().await;
    let l = BODY.len();
    let raw = post_with(&format!("Content-Length: {l}, {}\r\n", l + 5), BODY);
    let p = probe(addr, raw, BOUND).await;
    report("content_length_comma_conflict", &p);
    assert!(is_clean_reject(&p), "{p:?}");
    assert_ne!(p.status, Some(200));
}

#[tokio::test]
async fn non_numeric_and_signed_content_length_are_400() {
    let addr = spawn_server().await;
    for (name, v) in [
        ("plus", "+10"),
        ("minus", "-1"),
        ("hex", "0x10"),
        ("alpha", "ten"),
    ] {
        let raw = post_with(&format!("Content-Length: {v}\r\n"), BODY);
        let p = probe(addr, raw, BOUND).await;
        report(&format!("content_length_{name}"), &p);
        assert!(is_clean_reject(&p), "{name}: {p:?}");
        assert_ne!(p.status, Some(200), "{name}");
    }
}

#[tokio::test]
async fn content_length_plus_chunked_is_rejected() {
    let addr = spawn_server().await;
    let l = BODY.len();
    // A well-formed chunked body, so only the CL+TE combination can explain a rejection.
    let chunked = format!("{:x}\r\n{BODY}\r\n0\r\n\r\n", BODY.len());
    for (name, headers) in [
        (
            "cl_first",
            format!("Content-Length: {l}\r\nTransfer-Encoding: chunked\r\n"),
        ),
        (
            "te_first",
            format!("Transfer-Encoding: chunked\r\nContent-Length: {l}\r\n"),
        ),
        (
            "mixed_case",
            format!("CONTENT-length: {l}\r\ntransfer-ENCODING: Chunked\r\n"),
        ),
    ] {
        let p = probe(addr, post_with(&headers, &chunked), BOUND).await;
        report(&format!("content_length_plus_chunked_{name}"), &p);
        // RFC 9112 6.1: such a message "ought to be handled as an error" (smuggling risk behind a proxy).
        // hyper removes Content-Length before the service sees it, so this is caught on the raw bytes.
        assert_eq!(p.status, Some(400), "{name}: {p:?}");
        assert!(!p.timed_out && p.elapsed < BOUND, "{name}: {p:?}");
    }
}

#[tokio::test]
async fn plain_chunked_and_plain_content_length_are_still_served() {
    let addr = spawn_server().await;
    let chunked = format!("{:x}\r\n{BODY}\r\n0\r\n\r\n", BODY.len());
    let p = probe(
        addr,
        post_with("Transfer-Encoding: chunked\r\n", &chunked),
        BOUND,
    )
    .await;
    report("plain_chunked", &p);
    assert_eq!(p.status, Some(200), "{p:?}");
    let p = probe(
        addr,
        post_with(&format!("Content-Length: {}\r\n", BODY.len()), BODY),
        BOUND,
    )
    .await;
    report("plain_content_length", &p);
    assert_eq!(p.status, Some(200), "{p:?}");
}

#[tokio::test]
async fn transfer_encoding_on_http10_is_400() {
    let addr = spawn_server().await;
    let chunked = format!("{:x}\r\n{BODY}\r\n0\r\n\r\n", BODY.len());
    let raw = format!(
        "POST /api/v1/tenants HTTP/1.0\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n{chunked}"
    )
    .into_bytes();
    let p = probe(addr, raw, BOUND).await;
    report("http10_transfer_encoding", &p);
    assert_eq!(p.status, Some(400), "{p:?}");
}

/// On a keep-alive connection the verdicts follow the requests: clean requests before the bad one are
/// served, the bad one is a 400 whose handler never runs, and the connection is closed after it.
#[tokio::test]
async fn pipelined_clean_requests_then_content_length_plus_chunked() {
    let addr = spawn_server().await;
    let l = BODY.len();
    let chunked = format!("{:x}\r\n{BODY}\r\n0\r\n\r\n", BODY.len());
    let mut raw = b"GET /api/v1/health HTTP/1.1\r\nHost: localhost\r\n\r\n".to_vec();
    raw.extend(post_with("Transfer-Encoding: chunked\r\n", &chunked));
    raw.extend(post_with(
        &format!("Content-Length: {l}\r\nTransfer-Encoding: chunked\r\n"),
        &chunked,
    ));
    let mut s = TcpStream::connect(addr).await.unwrap();
    s.write_all(&raw).await.unwrap();
    let mut out = Vec::new();
    let _ = tokio::time::timeout(BOUND, s.read_to_end(&mut out)).await;
    let text = String::from_utf8_lossy(&out);
    // The responses follow each other without a line break after the body, so find each status line.
    let statuses: Vec<&str> = text
        .match_indices("HTTP/1.1 ")
        .map(|(i, _)| &text[i + 9..i + 12])
        .collect();
    println!("FRAMING case=pipelined statuses={statuses:?}");
    assert_eq!(statuses, ["200", "200", "400"], "{text}");
    // Only the first POST ran its handler.
    assert_eq!(text.matches("name_len").count(), 1, "{text}");
}

#[tokio::test]
async fn oversized_single_header_is_rejected_quickly() {
    let addr = spawn_server().await;
    let big = "a".repeat(1024 * 1024);
    let raw = post_with(
        &format!("X-Big: {big}\r\nContent-Length: {}\r\n", BODY.len()),
        BODY,
    );
    let p = probe(addr, raw, BOUND).await;
    report("oversized_header_1mib", &p);
    assert!(is_clean_reject(&p), "{p:?}");
    assert_ne!(p.status, Some(200));
}

#[tokio::test]
async fn too_many_headers_are_rejected() {
    let addr = spawn_server().await;
    let mut extra = String::new();
    for i in 0..300 {
        extra.push_str(&format!("X-H{i}: v\r\n"));
    }
    extra.push_str(&format!("Content-Length: {}\r\n", BODY.len()));
    let p = probe(addr, post_with(&extra, BODY), BOUND).await;
    report("too_many_headers_300", &p);
    assert!(is_clean_reject(&p), "{p:?}");
    assert_ne!(p.status, Some(200));
}

#[tokio::test]
async fn http10_without_host_gets_a_clean_answer() {
    let addr = spawn_server().await;
    let p = probe(addr, b"GET /api/v1/health HTTP/1.0\r\n\r\n".to_vec(), BOUND).await;
    report("http10_no_host", &p);
    // HTTP/1.0 has no Host requirement (RFC 9112 3.2 only requires it in 1.1): a plain answer is correct.
    assert!(!p.timed_out && p.elapsed < BOUND, "{p:?}");
    assert!(
        matches!(p.status, Some(200)) || is_clean_reject(&p),
        "{p:?}"
    );
}

#[tokio::test]
#[ignore = "B-282: the management API has no Host header check; hyper answers an HTTP/1.1 request without Host with 200"]
async fn http11_without_host_is_400() {
    let addr = spawn_server().await;
    let p = probe(addr, b"GET /api/v1/health HTTP/1.1\r\n\r\n".to_vec(), BOUND).await;
    report("http11_no_host", &p);
    assert!(is_clean_reject(&p), "{p:?}");
    assert_ne!(p.status, Some(200));
}

#[tokio::test]
async fn truncated_json_body_with_full_length_is_a_4xx() {
    let addr = spawn_server().await;
    let cut = &BODY[..BODY.len() - 8];
    let raw = post_with(&format!("Content-Length: {}\r\n", cut.len()), cut);
    let p = probe(addr, raw, BOUND).await;
    report("truncated_json_complete_framing", &p);
    assert!(is_clean_reject(&p), "{p:?}");
    assert_ne!(p.status, Some(200));
}

#[tokio::test]
async fn json_batch_of_10k_as_http_body_is_a_fast_4xx() {
    let addr = spawn_server().await;
    let entry =
        r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"echo","arguments":{}}}"#;
    let body = format!("[{}]", vec![entry; 10_000].join(","));
    let raw = post_with(&format!("Content-Length: {}\r\n", body.len()), &body);
    let p = probe(addr, raw, BOUND).await;
    report("batch_10k_http_body", &p);
    assert!(is_clean_reject(&p), "{p:?}");
    assert_ne!(p.status, Some(200));
}

#[test]
fn json_rpc_batch_of_10k_is_an_error_in_bounded_time() {
    let entry =
        r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"echo","arguments":{}}}"#;
    let frame = format!("[{}]", vec![entry; 10_000].join(","));
    let start = Instant::now();
    let v = validate_jsonrpc(&frame);
    let elapsed = start.elapsed();
    println!(
        "FRAMING case=jsonrpc_batch_10k layer=validate_jsonrpc ms={} bytes={}",
        elapsed.as_millis(),
        frame.len()
    );
    assert!(elapsed < BOUND, "{elapsed:?}");
    assert!(matches!(v, JsonRpcValidation::Error { .. }), "{v:?}");
}

#[test]
fn json_rpc_empty_and_nested_batches_are_errors() {
    for frame in ["[]", "[[]]", "[[[[[[[[[[1]]]]]]]]]]"] {
        let v = validate_jsonrpc(frame);
        assert!(
            matches!(v, JsonRpcValidation::Error { .. }),
            "{frame}: {v:?}"
        );
    }
}

#[tokio::test]
async fn deeply_nested_json_body_is_a_4xx_not_a_crash() {
    let addr = spawn_server().await;
    let body = format!("{}{}", "[".repeat(100_000), "]".repeat(100_000));
    let raw = post_with(&format!("Content-Length: {}\r\n", body.len()), &body);
    let p = probe(addr, raw, BOUND).await;
    report("deep_nesting_100k", &p);
    assert!(is_clean_reject(&p), "{p:?}");
}

#[test]
fn json_rpc_deeply_nested_frame_does_not_overflow_the_stack() {
    let frame = format!("{}{}", "[".repeat(100_000), "]".repeat(100_000));
    let v = validate_jsonrpc(&frame);
    assert!(matches!(v, JsonRpcValidation::Error { .. }), "{v:?}");
}

/// A JSON array is positional for the serde derive, so ["2.0", <object>, "ping"] reads as jsonrpc="2.0",
/// id=<object>, method="ping": a pass-through that is forwarded as the raw line. A downstream server that
/// supports JSON-RPC batching would then run the embedded object as a request, unchecked.
#[test]
fn positional_array_cannot_smuggle_a_tool_call_past_the_validator() {
    let frame = r#"["2.0",{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"bash","arguments":{"command":"echo example"}}},"ping"]"#;
    let v = validate_jsonrpc(frame);
    assert!(matches!(v, JsonRpcValidation::Error { .. }), "{v:?}");
}

/// Client sends the headers of a POST with Content-Length 1000, 10 bytes of body, then goes silent.
#[tokio::test]
async fn stalled_body_is_closed_within_a_bound() {
    let addr = spawn_server().await;
    let raw = post_with("Content-Length: 1000\r\n", "0123456789");
    let p = probe(addr, raw, Duration::from_secs(5)).await;
    report("slow_body_stall", &p);
    assert!(
        !p.timed_out,
        "server kept the stalled connection open: {p:?}"
    );
}

/// Client sends a partial request line and header block, then goes silent (classic slowloris).
#[tokio::test]
async fn stalled_headers_are_closed_within_a_bound() {
    let addr = spawn_server().await;
    let p = probe(
        addr,
        b"POST /api/v1/tenants HTTP/1.1\r\nHost: local".to_vec(),
        Duration::from_secs(5),
    )
    .await;
    report("slow_headers_stall", &p);
    assert!(
        !p.timed_out,
        "server kept the half-sent request open: {p:?}"
    );
}

/// A tool call hidden in a positional array comes back as an error (the same parse error every other
/// non-object frame gets), never as a pass-through.
#[test]
fn array_frame_is_rejected() {
    let frame = r#"["2.0",{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"bash","arguments":{"command":"echo example"}}},"ping"]"#;
    match validate_jsonrpc(frame) {
        JsonRpcValidation::Error { code, message, .. } => {
            assert_eq!(code, crate::jsonrpc::jsonrpc_error::PARSE_ERROR);
            assert!(message.contains("batches are not supported"), "{message}");
        }
        other => panic!("expected Error, got {other:?}"),
    }
    // A well-formed batch of objects is rejected the same way: the gateway does not check batches.
    let batch =
        r#"[{"jsonrpc":"2.0","id":1,"method":"ping"},{"jsonrpc":"2.0","id":2,"method":"ping"}]"#;
    assert!(matches!(
        validate_jsonrpc(batch),
        JsonRpcValidation::Error { .. }
    ));
}

#[test]
fn scalar_frames_are_rejected() {
    for frame in ["\"ping\"", "42", "-1.5", "true", "false", "null"] {
        match validate_jsonrpc(frame) {
            JsonRpcValidation::Error { code, .. } => {
                assert_eq!(code, crate::jsonrpc::jsonrpc_error::PARSE_ERROR, "{frame}")
            }
            other => panic!("{frame}: expected Error, got {other:?}"),
        }
    }
}

#[test]
fn normal_object_frames_still_pass() {
    let ping = r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#;
    assert!(matches!(
        validate_jsonrpc(ping),
        JsonRpcValidation::PassThrough
    ));
    let call = r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"echo","arguments":{"text":"example"}}}"#;
    match validate_jsonrpc(call) {
        JsonRpcValidation::ToolCall { tool_name, .. } => assert_eq!(tool_name, "echo"),
        other => panic!("expected ToolCall, got {other:?}"),
    }
    // Leading whitespace is still a plain object.
    assert!(matches!(
        validate_jsonrpc(&format!("  \n{ping}")),
        JsonRpcValidation::PassThrough
    ));
}

/// A client that stays silent after the slowloris-style first bytes loses the connection at the header
/// limit (300 ms here), well before the probe gives up.
#[tokio::test]
async fn slow_headers_are_closed_at_the_header_timeout() {
    let addr = spawn_server().await;
    let p = probe(
        addr,
        b"POST /api/v1/tenants HTTP/1.1\r\nHost: local".to_vec(),
        Duration::from_secs(5),
    )
    .await;
    report("header_timeout", &p);
    assert!(!p.timed_out, "{p:?}");
    assert!(p.elapsed >= Duration::from_millis(250), "{p:?}");
    assert!(p.elapsed < Duration::from_secs(3), "{p:?}");
}

/// Same for a body that stops short of its Content-Length: the request fails and the answer is a 4xx.
#[tokio::test]
async fn stalled_body_is_a_4xx_after_the_body_timeout() {
    let addr = spawn_server().await;
    let raw = post_with("Content-Length: 1000\r\n", "0123456789");
    let p = probe(addr, raw, Duration::from_secs(5)).await;
    report("body_timeout", &p);
    assert!(!p.timed_out, "{p:?}");
    assert!(p.elapsed < Duration::from_secs(3), "{p:?}");
    assert!(is_clean_reject(&p), "{p:?}");
}

/// A body that keeps moving is not cut: each chunk restarts the idle timer.
#[tokio::test]
async fn slow_but_moving_body_is_served() {
    let addr = spawn_server().await;
    let mut s = TcpStream::connect(addr).await.unwrap();
    let head = format!(
        "POST /api/v1/tenants HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
        BODY.len()
    );
    s.write_all(head.as_bytes()).await.unwrap();
    // Three pieces 200 ms apart: longer than the 300 ms idle limit in total, never idle for 300 ms.
    let bytes = BODY.as_bytes();
    let third = bytes.len() / 3;
    for part in [
        &bytes[..third],
        &bytes[third..2 * third],
        &bytes[2 * third..],
    ] {
        s.write_all(part).await.unwrap();
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    let mut buf = vec![0u8; 4096];
    let n = tokio::time::timeout(BOUND, s.read(&mut buf))
        .await
        .expect("no answer")
        .unwrap();
    let text = String::from_utf8_lossy(&buf[..n]);
    assert!(text.starts_with("HTTP/1.1 200"), "{text}");
}

/// With the cap at 3, three idle clients take every slot: a fourth gets no answer until one leaves.
#[tokio::test]
async fn connection_cap_holds() {
    let addr = spawn_server_with(ServeLimits {
        header_read_timeout: Duration::from_secs(30),
        body_idle_timeout: Duration::from_secs(30),
        max_connections: 3,
    })
    .await;
    let mut held = Vec::new();
    for _ in 0..3 {
        let mut c = TcpStream::connect(addr).await.unwrap();
        // One finished request proves the slot is in use (keep-alive keeps it open).
        c.write_all(b"GET /api/v1/health HTTP/1.1\r\nHost: localhost\r\n\r\n")
            .await
            .unwrap();
        let mut buf = [0u8; 1024];
        let n = tokio::time::timeout(BOUND, c.read(&mut buf))
            .await
            .expect("no answer")
            .unwrap();
        assert!(String::from_utf8_lossy(&buf[..n]).starts_with("HTTP/1.1 200"));
        held.push(c);
    }
    let blocked = probe(
        addr,
        b"GET /api/v1/health HTTP/1.1\r\nHost: localhost\r\n\r\n".to_vec(),
        Duration::from_millis(700),
    )
    .await;
    report("cap_blocked", &blocked);
    assert!(
        blocked.timed_out,
        "a fourth connection was served over the cap: {blocked:?}"
    );
    // Free one slot: a new client is served.
    drop(held.pop());
    let served = probe(
        addr,
        b"GET /api/v1/health HTTP/1.1\r\nHost: localhost\r\n\r\n".to_vec(),
        BOUND,
    )
    .await;
    report("cap_after_release", &served);
    assert_eq!(served.status, Some(200), "{served:?}");
}

/// A WebSocket session outlives the header and body timeouts (300 ms each here) and still echoes.
#[tokio::test]
async fn websocket_outlives_the_body_and_header_timeouts() {
    let addr = spawn_server().await;
    let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/ws"))
        .await
        .expect("websocket handshake");
    tokio::time::sleep(Duration::from_millis(1500)).await;
    ws.send(tokio_tungstenite::tungstenite::Message::Text(
        "still here".into(),
    ))
    .await
    .expect("send after the timeouts");
    let reply = tokio::time::timeout(BOUND, ws.next())
        .await
        .expect("no echo")
        .expect("closed")
        .expect("error");
    match reply {
        tokio_tungstenite::tungstenite::Message::Text(t) => assert_eq!(t.as_str(), "still here"),
        other => panic!("unexpected {other:?}"),
    }
}
