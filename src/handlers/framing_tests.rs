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
use crate::jsonrpc::{validate_jsonrpc, JsonRpcValidation};
use axum::{
    routing::{get, post},
    Json, Router,
};
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

async fn spawn_server() -> SocketAddr {
    let app = Router::new()
        .route("/api/v1/health", get(health))
        .route("/api/v1/tenants", post(tenants));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    addr
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
    !p.timed_out && p.elapsed < BOUND && p.status.map_or(true, |s| (400..500).contains(&s))
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
#[ignore = "B-1258: hyper accepts Content-Length plus Transfer-Encoding: chunked (chunked wins) and answers 200"]
async fn content_length_plus_chunked_is_rejected() {
    let addr = spawn_server().await;
    let l = BODY.len();
    // A well-formed chunked body, so only the CL+TE combination can explain a rejection.
    let chunked = format!("{:x}\r\n{BODY}\r\n0\r\n\r\n", BODY.len());
    let raw = post_with(
        &format!("Content-Length: {l}\r\nTransfer-Encoding: chunked\r\n"),
        &chunked,
    );
    let p = probe(addr, raw, BOUND).await;
    report("content_length_plus_chunked", &p);
    // RFC 9112 6.1 says such a message "ought to be handled as an error" (smuggling risk behind a proxy).
    assert!(is_clean_reject(&p), "{p:?}");
    assert_ne!(p.status, Some(200));
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
#[ignore = "B-1256: validate_jsonrpc reads a positional JSON array as a request and returns PassThrough"]
fn positional_array_cannot_smuggle_a_tool_call_past_the_validator() {
    let frame = r#"["2.0",{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"bash","arguments":{"command":"echo example"}}},"ping"]"#;
    let v = validate_jsonrpc(frame);
    assert!(matches!(v, JsonRpcValidation::Error { .. }), "{v:?}");
}

/// Client sends the headers of a POST with Content-Length 1000, 10 bytes of body, then goes silent.
#[tokio::test]
#[ignore = "B-1257: axum::serve sets no header-read or body-read timeout, so a stalled body holds the connection forever"]
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
#[ignore = "B-1257: axum::serve sets no header-read or body-read timeout, so half-sent headers hold the connection forever"]
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
