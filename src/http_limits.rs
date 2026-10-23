//! Limits for the management API's HTTP server: how long a client may take to send its headers and body,
//! how many connections are served at once, and a framing check that rejects ambiguous requests.
//!
//! `axum::serve` sets none of these, so a client that sends half a request and goes silent (or opens a few
//! hundred idle sockets) held a connection, and a file descriptor, for as long as it liked. This module
//! runs the same router on hyper directly, with the three limits applied.
//!
//! # Ambiguous framing (RFC 9112 6.1)
//!
//! A request that carries both `Content-Length` and `Transfer-Encoding` can be read two ways, and a proxy
//! in front may pick the other one (request smuggling). The RFC says to treat it as an error. hyper does
//! not: it lets `chunked` win and **removes `Content-Length` from the request before the service sees it**,
//! so no tower layer can detect the case from the headers alone. (hyper does reject `Transfer-Encoding` on
//! HTTP/1.0 and a non-chunked final encoding by itself, closing the connection.)
//!
//! So the connection's reader is wrapped in [`FramingGuardIo`], which follows the request framing on the
//! raw bytes with `httparse` (the parser hyper uses): it parses each request head, then skips the body
//! (by `Content-Length`, or chunk by chunk), and records one verdict per request. The
//! [`reject_ambiguous_framing`] layer is the outermost layer; it takes the verdict for the request it is
//! handling and answers 400 with `Connection: close` before any other layer or handler runs. The tracker
//! stops (fails open) when it cannot follow the stream, which only happens after hyper has already failed
//! the request or when the connection is no longer HTTP (an upgraded WebSocket).

use axum::{
    body::Body,
    extract::{ConnectInfo, Request, State},
    http::{header, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    Extension, Router,
};
use hyper::server::conn::http1;
use hyper_util::{
    rt::{TokioIo, TokioTimer},
    service::TowerToHyperService,
};
use std::{
    borrow::Cow,
    collections::VecDeque,
    io,
    net::SocketAddr,
    pin::Pin,
    sync::{Arc, Mutex},
    task::{Context, Poll},
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncWrite, ReadBuf},
    net::TcpListener,
    sync::Semaphore,
};
use tower_http::timeout::TimeoutBody;

/// How long a client may take to send the request line and headers.
pub const HEADER_READ_TIMEOUT: Duration = Duration::from_secs(10);
/// How long a request body may go without a new chunk before the request is failed.
pub const BODY_IDLE_TIMEOUT: Duration = Duration::from_secs(30);
/// How many connections are served at once; more wait in the kernel's accept queue.
pub const MAX_CONNECTIONS: usize = 256;

/// The three limits. `Default` is what the gateway runs with; tests pass short values.
#[derive(Debug, Clone, Copy)]
pub struct ServeLimits {
    pub header_read_timeout: Duration,
    pub body_idle_timeout: Duration,
    pub max_connections: usize,
}

impl Default for ServeLimits {
    fn default() -> Self {
        Self {
            header_read_timeout: HEADER_READ_TIMEOUT,
            body_idle_timeout: BODY_IDLE_TIMEOUT,
            max_connections: MAX_CONNECTIONS,
        }
    }
}

/// Fail a request whose body stalls. The timer restarts on every chunk, so a large upload that keeps
/// moving is fine. It only wraps the request body: an upgraded WebSocket is not a body and is not cut.
async fn body_idle_timeout(State(idle): State<Duration>, req: Request, next: Next) -> Response {
    let (parts, body) = req.into_parts();
    let req = Request::from_parts(parts, Body::new(TimeoutBody::new(idle, body)));
    next.run(req).await
}

/// More than hyper accepts for a request head (about 417 KiB): past this the tracker calls it bad.
const MAX_HEAD_BYTES: usize = 512 * 1024;
/// Longest chunk-size or trailer line the tracker follows before it stops tracking the connection.
const MAX_LINE_BYTES: usize = 64 * 1024;
/// More headers than hyper's default limit of 100.
const MAX_HEADERS: usize = 128;

/// Per-connection queue of verdicts, one per request head in arrival order (`true` = ambiguous framing).
#[derive(Clone, Default)]
pub struct FramingVerdicts(Arc<Mutex<VecDeque<bool>>>);

impl FramingVerdicts {
    fn push(&self, bad: bool) {
        if let Ok(mut q) = self.0.lock() {
            q.push_back(bad);
        }
    }

    fn pop(&self) -> bool {
        self.0
            .lock()
            .ok()
            .and_then(|mut q| q.pop_front())
            .unwrap_or(false)
    }
}

#[derive(Debug)]
enum FrameState {
    /// Accumulating a request head.
    Head(Vec<u8>),
    /// Skipping this many body bytes.
    Skip(u64),
    /// Reading a chunk-size line.
    ChunkSize(Vec<u8>),
    /// Skipping this many bytes of chunk data plus its CRLF.
    ChunkData(u64),
    /// Reading trailer lines up to the empty line.
    Trailers(Vec<u8>),
    /// Not following this connection any more.
    Off,
}

/// Follows HTTP/1.x request framing on the raw bytes read from a connection.
#[derive(Debug)]
struct FramingTracker {
    state: FrameState,
}

/// Move bytes from `data` into `line` up to and including the next `\n`. True when a full line is held.
fn take_line(line: &mut Vec<u8>, data: &mut &[u8]) -> bool {
    match data.iter().position(|&b| b == b'\n') {
        Some(i) => {
            line.extend_from_slice(&data[..=i]);
            *data = &data[i + 1..];
            true
        }
        None => {
            line.extend_from_slice(data);
            *data = &[];
            false
        }
    }
}

/// Parse the hex size at the start of a chunk-size line (an extension after `;` is ignored).
fn chunk_size(line: &[u8]) -> Option<u64> {
    let end = line
        .iter()
        .position(|&b| b == b';' || b == b'\r' || b == b'\n')
        .unwrap_or(line.len());
    let digits = std::str::from_utf8(&line[..end]).ok()?.trim();
    if digits.is_empty() || digits.len() > 16 {
        return None;
    }
    u64::from_str_radix(digits, 16).ok()
}

/// What the head of one request says about its framing.
struct Head {
    ambiguous: bool,
    chunked: bool,
    has_te: bool,
    content_length: Option<u64>,
}

impl Head {
    fn of(req: &httparse::Request<'_, '_>) -> Self {
        let mut has_cl = false;
        let mut has_te = false;
        let mut chunked = false;
        let mut content_length = None;
        for h in req.headers.iter() {
            if h.name.eq_ignore_ascii_case("content-length") {
                has_cl = true;
                if content_length.is_none() {
                    content_length = std::str::from_utf8(h.value)
                        .ok()
                        .and_then(|v| v.trim().parse::<u64>().ok());
                }
            } else if h.name.eq_ignore_ascii_case("transfer-encoding") {
                has_te = true;
                // Like hyper: the last Transfer-Encoding line decides, and chunked must be its last coding.
                chunked = std::str::from_utf8(h.value)
                    .ok()
                    .and_then(|v| v.rsplit(',').next())
                    .is_some_and(|c| c.trim().eq_ignore_ascii_case("chunked"));
            }
        }
        let http10 = req.version == Some(0);
        Head {
            ambiguous: (has_cl && has_te) || (has_te && http10),
            chunked,
            has_te,
            content_length,
        }
    }
}

impl FramingTracker {
    fn new() -> Self {
        Self {
            state: FrameState::Head(Vec::new()),
        }
    }

    /// Consume bytes just read from the connection and record a verdict for every request head in them.
    fn feed(&mut self, bytes: &[u8], out: &FramingVerdicts) {
        let mut data: Cow<[u8]> = Cow::Borrowed(bytes);
        loop {
            if data.is_empty() {
                return;
            }
            let mut input: &[u8] = &data;
            match &mut self.state {
                FrameState::Off => return,
                FrameState::Skip(n) => {
                    let take = (*n).min(input.len() as u64);
                    *n -= take;
                    input = &input[take as usize..];
                    if *n == 0 {
                        self.state = FrameState::Head(Vec::new());
                    }
                }
                FrameState::ChunkData(n) => {
                    let take = (*n).min(input.len() as u64);
                    *n -= take;
                    input = &input[take as usize..];
                    if *n == 0 {
                        self.state = FrameState::ChunkSize(Vec::new());
                    }
                }
                FrameState::ChunkSize(line) => {
                    if take_line(line, &mut input) {
                        match chunk_size(line) {
                            Some(0) => self.state = FrameState::Trailers(Vec::new()),
                            Some(n) => self.state = FrameState::ChunkData(n.saturating_add(2)),
                            None => self.state = FrameState::Off,
                        }
                    } else if line.len() > MAX_LINE_BYTES {
                        self.state = FrameState::Off;
                    }
                }
                FrameState::Trailers(line) => {
                    if take_line(line, &mut input) {
                        if line.iter().all(|&b| b == b'\r' || b == b'\n') {
                            self.state = FrameState::Head(Vec::new());
                        } else {
                            line.clear();
                        }
                    } else if line.len() > MAX_LINE_BYTES {
                        self.state = FrameState::Off;
                    }
                }
                FrameState::Head(buf) => {
                    buf.extend_from_slice(input);
                    input = &[];
                    let mut headers = [httparse::EMPTY_HEADER; MAX_HEADERS];
                    let mut req = httparse::Request::new(&mut headers);
                    match req.parse(buf) {
                        Ok(httparse::Status::Complete(n)) => {
                            let head = Head::of(&req);
                            let rest = buf[n..].to_vec();
                            out.push(head.ambiguous);
                            self.state = if head.ambiguous {
                                // hyper closes after this request.
                                FrameState::Off
                            } else if head.has_te {
                                if head.chunked {
                                    FrameState::ChunkSize(Vec::new())
                                } else {
                                    FrameState::Off // hyper answers 400 and closes
                                }
                            } else {
                                match head.content_length {
                                    Some(0) | None => FrameState::Head(Vec::new()),
                                    Some(len) => FrameState::Skip(len),
                                }
                            };
                            data = Cow::Owned(rest);
                            continue;
                        }
                        Ok(httparse::Status::Partial) => {
                            if buf.len() > MAX_HEAD_BYTES {
                                out.push(true);
                                self.state = FrameState::Off;
                            }
                            return;
                        }
                        // hyper fails the same bytes and closes the connection.
                        Err(_) => self.state = FrameState::Off,
                    }
                }
            }
            data = Cow::Owned(input.to_vec());
        }
    }
}

/// A connection's reader with a [`FramingTracker`] watching the bytes. Writes pass straight through.
struct FramingGuardIo<T> {
    inner: T,
    tracker: FramingTracker,
    verdicts: FramingVerdicts,
}

impl<T: AsyncRead + Unpin> AsyncRead for FramingGuardIo<T> {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        let before = buf.filled().len();
        let res = Pin::new(&mut this.inner).poll_read(cx, buf);
        if let Poll::Ready(Ok(())) = &res {
            this.tracker.feed(&buf.filled()[before..], &this.verdicts);
        }
        res
    }
}

impl<T: AsyncWrite + Unpin> AsyncWrite for FramingGuardIo<T> {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        data: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.get_mut().inner).poll_write(cx, data)
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_flush(cx)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_shutdown(cx)
    }

    fn poll_write_vectored(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bufs: &[io::IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.get_mut().inner).poll_write_vectored(cx, bufs)
    }

    fn is_write_vectored(&self) -> bool {
        self.inner.is_write_vectored()
    }
}

/// Answer 400 to a request that carried both `Content-Length` and `Transfer-Encoding`, or
/// `Transfer-Encoding` on HTTP/1.0 (RFC 9112 6.1). Outermost layer: it runs before every handler.
async fn reject_ambiguous_framing(
    Extension(verdicts): Extension<FramingVerdicts>,
    req: Request,
    next: Next,
) -> Response {
    // Always take the verdict, so the queue stays in step with the requests.
    let ambiguous = verdicts.pop()
        || (req.version() == axum::http::Version::HTTP_10
            && req.headers().contains_key(header::TRANSFER_ENCODING));
    if ambiguous {
        return (
            StatusCode::BAD_REQUEST,
            [(header::CONNECTION, "close")],
            "Content-Length together with Transfer-Encoding is not allowed",
        )
            .into_response();
    }
    next.run(req).await
}

/// Serve `app` on `listener` until the task is dropped. Handlers still see `ConnectInfo<SocketAddr>`.
pub async fn serve_limited(listener: TcpListener, app: Router, limits: ServeLimits) {
    let app = app
        .layer(middleware::from_fn_with_state(
            limits.body_idle_timeout,
            body_idle_timeout,
        ))
        .layer(middleware::from_fn(reject_ambiguous_framing));
    let slots = Arc::new(Semaphore::new(limits.max_connections.max(1)));
    loop {
        // Take a slot before accepting, so at the cap the next client waits in the kernel queue.
        let Ok(permit) = Arc::clone(&slots).acquire_owned().await else {
            return;
        };
        let (stream, remote) = match listener.accept().await {
            Ok(accepted) => accepted,
            Err(e) => {
                // Usually out of file descriptors: back off instead of spinning.
                tracing::warn!("Management API accept failed: {}", e);
                tokio::time::sleep(Duration::from_millis(500)).await;
                continue;
            }
        };
        let verdicts = FramingVerdicts::default();
        let service = TowerToHyperService::new(
            app.clone()
                .layer(Extension(ConnectInfo::<SocketAddr>(remote)))
                .layer(Extension(verdicts.clone())),
        );
        let io = FramingGuardIo {
            inner: stream,
            tracker: FramingTracker::new(),
            verdicts,
        };
        tokio::spawn(async move {
            // The slot is held until the connection ends, a WebSocket session included.
            let _permit = permit;
            let conn = http1::Builder::new()
                .timer(TokioTimer::new())
                .header_read_timeout(limits.header_read_timeout)
                .serve_connection(TokioIo::new(io), service)
                .with_upgrades();
            if let Err(e) = conn.await {
                tracing::debug!("Management API connection ended: {}", e);
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(chunks: &[&[u8]]) -> Vec<bool> {
        let v = FramingVerdicts::default();
        let mut t = FramingTracker::new();
        for c in chunks {
            t.feed(c, &v);
        }
        let mut out = Vec::new();
        while let Some(b) = v.0.lock().unwrap().pop_front() {
            out.push(b);
        }
        out
    }

    const PIPELINE: &[u8] = b"POST /a HTTP/1.1\r\nHost: x\r\nContent-Length: 5\r\n\r\nhelloPOST /b HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n3;e=1\r\nabc\r\n0\r\nX-T: 1\r\n\r\nGET /c HTTP/1.1\r\nHost: x\r\n\r\nPOST /d HTTP/1.1\r\nHost: x\r\nContent-Length: 3\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n";

    #[test]
    fn pipelined_requests_get_one_verdict_each() {
        assert_eq!(run(&[PIPELINE]), vec![false, false, false, true]);
    }

    #[test]
    fn verdicts_do_not_depend_on_how_the_bytes_are_split() {
        let one_by_one: Vec<&[u8]> = PIPELINE.chunks(1).collect();
        assert_eq!(run(&one_by_one), vec![false, false, false, true]);
        let sevens: Vec<&[u8]> = PIPELINE.chunks(7).collect();
        assert_eq!(run(&sevens), vec![false, false, false, true]);
    }

    #[test]
    fn either_header_order_is_flagged() {
        let a = b"POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\ncontent-length: 1\r\n\r\n";
        let b = b"POST / HTTP/1.1\r\nCONTENT-LENGTH: 1\r\ntransfer-encoding: Chunked\r\n\r\n";
        assert_eq!(run(&[a]), vec![true]);
        assert_eq!(run(&[b]), vec![true]);
    }

    #[test]
    fn bare_lf_line_endings_are_followed_too() {
        let a = b"POST / HTTP/1.1\nContent-Length: 1\nTransfer-Encoding: chunked\n\n";
        assert_eq!(run(&[a]), vec![true]);
    }

    #[test]
    fn http10_with_transfer_encoding_is_flagged() {
        let a = b"POST / HTTP/1.0\r\nTransfer-Encoding: chunked\r\n\r\n";
        assert_eq!(run(&[a]), vec![true]);
    }

    #[test]
    fn plain_requests_are_not_flagged() {
        let a = b"GET / HTTP/1.0\r\n\r\nPOST / HTTP/1.1\r\nContent-Length: 0\r\n\r\n";
        assert_eq!(run(&[a]), vec![false, false]);
    }

    #[test]
    fn a_body_that_looks_like_a_head_is_not_a_request() {
        let a = b"POST / HTTP/1.1\r\nContent-Length: 62\r\n\r\nPOST / HTTP/1.1\r\nContent-Length: 1\r\nTransfer-Encoding: chunked";
        // The 62-byte body is skipped, so only the first head gets a verdict.
        assert_eq!(run(&[a]), vec![false]);
    }

    #[test]
    fn websocket_frames_after_the_handshake_stop_the_tracker() {
        let a = b"GET /ws HTTP/1.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n\x81\x85\x01\x02\x03\x04abcde";
        assert_eq!(run(&[a]), vec![false]);
    }
}
