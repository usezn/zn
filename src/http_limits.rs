//! Limits for the management API's HTTP server: how long a client may take to send its headers and body,
//! how many connections are served at once, and how long a connection may sit idle or stuck.
//!
//! `axum::serve` sets none of these, so a client that sends half a request and goes silent (or opens a few
//! hundred idle sockets) held a connection, and a file descriptor, for as long as it liked. This module
//! runs the same router on hyper directly, with the limits applied:
//!
//! - **Header and body timeouts**: a slow request is cut.
//! - **Connection cap, with room for real clients**: at the cap, a new connection takes the place of the
//!   oldest idle connection, preferring one that has not yet had a request answered successfully (a socket
//!   that only connected, or whose requests were all refused). A connection that is answering a request is
//!   never evicted; a served connection that is merely idle (keep-alive) can be, so idle sockets cannot
//!   keep the dashboard out, however they got their first 200.
//! - **Write timeout and idle time**: a peer that stops reading is cut after `write_timeout`, and a
//!   connection that has sent nothing for `session_idle_timeout` is closed. The second one is what ends an
//!   SSE stream or a WebSocket session nobody uses; the browser reconnects on its own.

use axum::{
    body::Body,
    extract::{ConnectInfo, Request, State},
    http::StatusCode,
    middleware::{self, Next},
    response::Response,
    Extension, Router,
};
use http_body_util::BodyExt;
use hyper::server::conn::http1;
use hyper_util::{
    rt::{TokioIo, TokioTimer},
    service::TowerToHyperService,
};
use std::{
    collections::BTreeMap,
    future::Future,
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
    sync::{Notify, Semaphore},
    time::{sleep, Instant, Sleep},
};
use tower_http::timeout::TimeoutBody;

/// How long a client may take to send the request line and headers.
pub const HEADER_READ_TIMEOUT: Duration = Duration::from_secs(10);
/// How long a request body may go without a new chunk before the request is failed.
pub const BODY_IDLE_TIMEOUT: Duration = Duration::from_secs(30);
/// How many connections are served at once; more wait in the kernel's accept queue.
pub const MAX_CONNECTIONS: usize = 256;
/// How long a write may stay blocked (a client that does not read) before the connection is closed.
pub const WRITE_TIMEOUT: Duration = Duration::from_secs(30);
/// How long a connection may go without receiving a byte from the client before it is closed. It ends an
/// unused SSE stream or WebSocket session (15 minutes).
pub const SESSION_IDLE_TIMEOUT: Duration = Duration::from_secs(900);

/// The limits. `Default` is what the gateway runs with; tests pass short values.
#[derive(Debug, Clone, Copy)]
pub struct ServeLimits {
    pub header_read_timeout: Duration,
    pub body_idle_timeout: Duration,
    pub max_connections: usize,
    pub write_timeout: Duration,
    pub session_idle_timeout: Duration,
}

impl ServeLimits {
    pub const DEFAULT: ServeLimits = ServeLimits {
        header_read_timeout: HEADER_READ_TIMEOUT,
        body_idle_timeout: BODY_IDLE_TIMEOUT,
        max_connections: MAX_CONNECTIONS,
        write_timeout: WRITE_TIMEOUT,
        session_idle_timeout: SESSION_IDLE_TIMEOUT,
    };

    /// The defaults, with the write timeout and idle time from the `server` settings (0 keeps the default).
    pub fn from_server(server: &crate::config::ServerConfig) -> Self {
        let secs = |v: u64, default: Duration| {
            if v == 0 {
                default
            } else {
                Duration::from_secs(v)
            }
        };
        Self {
            write_timeout: secs(server.write_timeout_secs, WRITE_TIMEOUT),
            session_idle_timeout: secs(server.session_idle_timeout_secs, SESSION_IDLE_TIMEOUT),
            ..Self::DEFAULT
        }
    }
}

impl Default for ServeLimits {
    fn default() -> Self {
        Self::DEFAULT
    }
}

/// Fail a request whose body stalls. The timer restarts on every chunk, so a large upload that keeps
/// moving is fine. It only wraps the request body: an upgraded WebSocket is not a body and is not cut.
async fn body_idle_timeout(State(idle): State<Duration>, req: Request, next: Next) -> Response {
    let (parts, body) = req.into_parts();
    let req = Request::from_parts(parts, Body::new(TimeoutBody::new(idle, body)));
    next.run(req).await
}

/// One open connection, as the cap sees it.
struct Entry {
    notify: Arc<Notify>,
    /// Requests being answered right now, response body included. While it is above zero the connection
    /// is never evicted.
    in_flight: u32,
    /// A request of this connection has ended in a success.
    served: bool,
}

/// The open connections, oldest first. When the cap is reached, a new connection takes the place of one
/// of the idle ones.
#[derive(Default)]
struct Registry {
    next_id: u64,
    conns: BTreeMap<u64, Entry>,
}

type SharedRegistry = Arc<Mutex<Registry>>;

fn lock(reg: &SharedRegistry) -> std::sync::MutexGuard<'_, Registry> {
    reg.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Tell the oldest idle connection to close: the oldest one never served if there is one, else the oldest
/// served one. A connection with a request in flight is never picked. Returns false when none is idle.
fn evict_oldest(reg: &SharedRegistry) -> bool {
    let mut g = lock(reg);
    let pick = |served: bool| {
        g.conns
            .iter()
            .find(|(_, e)| e.in_flight == 0 && e.served == served)
            .map(|(id, _)| *id)
    };
    let Some(id) = pick(false).or_else(|| pick(true)) else {
        return false;
    };
    if let Some(e) = g.conns.remove(&id) {
        e.notify.notify_one();
    }
    true
}

/// A connection's entry in the registry; it leaves the registry when dropped.
#[derive(Clone)]
struct ConnTag {
    id: u64,
    registry: SharedRegistry,
}

struct Unregister(ConnTag);

impl Drop for Unregister {
    fn drop(&mut self) {
        lock(&self.0.registry).conns.remove(&self.0.id);
    }
}

fn register(reg: &SharedRegistry) -> (ConnTag, Arc<Notify>, Unregister) {
    let notify = Arc::new(Notify::new());
    let mut g = lock(reg);
    let id = g.next_id;
    g.next_id += 1;
    g.conns.insert(
        id,
        Entry {
            notify: Arc::clone(&notify),
            in_flight: 0,
            served: false,
        },
    );
    let tag = ConnTag {
        id,
        registry: Arc::clone(reg),
    };
    (tag.clone(), notify, Unregister(tag))
}

/// Marks a request as in flight until dropped (the response body is dropped with it).
struct InFlight(ConnTag);

impl InFlight {
    fn start(tag: &ConnTag) -> Self {
        if let Some(e) = lock(&tag.registry).conns.get_mut(&tag.id) {
            e.in_flight += 1;
        }
        Self(tag.clone())
    }
}

impl Drop for InFlight {
    fn drop(&mut self) {
        if let Some(e) = lock(&self.0.registry).conns.get_mut(&self.0.id) {
            e.in_flight = e.in_flight.saturating_sub(1);
        }
    }
}

/// Keeps a connection safe from eviction while one of its requests is being answered, and notes when a
/// request ends in a 2xx, 3xx or 101 (a served connection is evicted only after the ones never served).
/// Authentication runs inside this layer, so a refused (401, 403), rate-limited (429) or malformed
/// request does not count as served.
async fn mark_served(tag: Option<Extension<ConnTag>>, req: Request, next: Next) -> Response {
    let Some(Extension(tag)) = tag else {
        return next.run(req).await;
    };
    let guard = InFlight::start(&tag);
    let response = next.run(req).await;
    let s = response.status();
    if s.is_success() || s.is_redirection() || s == StatusCode::SWITCHING_PROTOCOLS {
        if let Some(e) = lock(&tag.registry).conns.get_mut(&tag.id) {
            e.served = true;
        }
    }
    // The guard moves into the body, so a streamed response (SSE) counts as in flight until it ends.
    let (parts, body) = response.into_parts();
    let body = body.map_frame(move |frame| {
        let _keep = &guard;
        frame
    });
    Response::from_parts(parts, Body::new(body))
}

fn timed_out(what: &str) -> io::Error {
    io::Error::new(io::ErrorKind::TimedOut, what.to_string())
}

/// A socket with two timers. The idle timer restarts whenever a read returns; once it runs out, reads
/// and writes fail. The write timer starts when a write cannot make progress and fails the write if it
/// is still blocked after `write_for`.
struct LimitedIo<S> {
    inner: S,
    idle_for: Duration,
    write_for: Duration,
    idle: Pin<Box<Sleep>>,
    write: Option<Pin<Box<Sleep>>>,
}

impl<S> LimitedIo<S> {
    fn new(inner: S, idle_for: Duration, write_for: Duration) -> Self {
        Self {
            inner,
            idle_for,
            write_for,
            idle: Box::pin(sleep(idle_for)),
            write: None,
        }
    }

    fn idle_expired(&mut self, cx: &mut Context<'_>) -> bool {
        self.idle.as_mut().poll(cx).is_ready()
    }

    fn guard_write<T>(
        &mut self,
        cx: &mut Context<'_>,
        r: Poll<io::Result<T>>,
    ) -> Poll<io::Result<T>> {
        match r {
            Poll::Ready(v) => {
                self.write = None;
                Poll::Ready(v)
            }
            Poll::Pending => {
                let write_for = self.write_for;
                let timer = self.write.get_or_insert_with(|| Box::pin(sleep(write_for)));
                if timer.as_mut().poll(cx).is_ready() {
                    Poll::Ready(Err(timed_out("write timed out")))
                } else {
                    Poll::Pending
                }
            }
        }
    }
}

impl<S: AsyncRead + Unpin> AsyncRead for LimitedIo<S> {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        match Pin::new(&mut this.inner).poll_read(cx, buf) {
            Poll::Ready(r) => {
                this.idle.as_mut().reset(Instant::now() + this.idle_for);
                Poll::Ready(r)
            }
            Poll::Pending => {
                if this.idle_expired(cx) {
                    Poll::Ready(Err(timed_out("connection idle too long")))
                } else {
                    Poll::Pending
                }
            }
        }
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for LimitedIo<S> {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        // A stream that only writes (SSE keep-alives) still reaches the idle check here.
        if this.idle_expired(cx) {
            return Poll::Ready(Err(timed_out("connection idle too long")));
        }
        let r = Pin::new(&mut this.inner).poll_write(cx, buf);
        this.guard_write(cx, r)
    }

    fn poll_write_vectored(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bufs: &[io::IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        if this.idle_expired(cx) {
            return Poll::Ready(Err(timed_out("connection idle too long")));
        }
        let r = Pin::new(&mut this.inner).poll_write_vectored(cx, bufs);
        this.guard_write(cx, r)
    }

    fn is_write_vectored(&self) -> bool {
        self.inner.is_write_vectored()
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        let r = Pin::new(&mut this.inner).poll_flush(cx);
        this.guard_write(cx, r)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        let r = Pin::new(&mut this.inner).poll_shutdown(cx);
        this.guard_write(cx, r)
    }
}

/// Serve `app` on `listener` until the task is dropped. Handlers still see `ConnectInfo<SocketAddr>`.
pub async fn serve_limited(listener: TcpListener, app: Router, limits: ServeLimits) {
    let app = app
        .layer(middleware::from_fn_with_state(
            limits.body_idle_timeout,
            body_idle_timeout,
        ))
        .layer(middleware::from_fn(mark_served));
    let slots = Arc::new(Semaphore::new(limits.max_connections.max(1)));
    let registry: SharedRegistry = Arc::new(Mutex::new(Registry::default()));
    loop {
        let (stream, remote) = match listener.accept().await {
            Ok(accepted) => accepted,
            Err(e) => {
                // Usually out of file descriptors: back off instead of spinning.
                tracing::warn!("Management API accept failed: {}", e);
                sleep(Duration::from_millis(500)).await;
                continue;
            }
        };
        // At the cap, make room by closing the oldest idle connection (never one answering a request). If
        // every connection is busy, wait and try again. The new socket is held here meanwhile.
        let permit = match Arc::clone(&slots).try_acquire_owned() {
            Ok(p) => p,
            Err(_) => loop {
                evict_oldest(&registry);
                let wait = Arc::clone(&slots).acquire_owned();
                match tokio::time::timeout(Duration::from_millis(200), wait).await {
                    Ok(Ok(p)) => break p,
                    Ok(Err(_)) => return,
                    Err(_) => continue,
                }
            },
        };
        let (tag, evicted, unregister) = register(&registry);
        let service = TowerToHyperService::new(
            app.clone()
                .layer(Extension(ConnectInfo::<SocketAddr>(remote)))
                .layer(Extension(tag)),
        );
        tokio::spawn(async move {
            // The slot is held until the connection ends, a WebSocket session included.
            let _permit = permit;
            let _unregister = unregister;
            let io = LimitedIo::new(stream, limits.session_idle_timeout, limits.write_timeout);
            let conn = http1::Builder::new()
                .timer(TokioTimer::new())
                .header_read_timeout(limits.header_read_timeout)
                .serve_connection(TokioIo::new(io), service)
                .with_upgrades();
            tokio::pin!(conn);
            tokio::select! {
                r = &mut conn => {
                    if let Err(e) = r {
                        tracing::debug!("Management API connection ended: {}", e);
                    }
                }
                _ = evicted.notified() => {
                    tracing::debug!("Management API connection closed to make room");
                }
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Bytes, extract::ws::WebSocketUpgrade, response::IntoResponse, routing::get};
    use futures::{SinkExt, StreamExt};
    use std::time::Instant as StdInstant;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpStream;
    use tokio_tungstenite::tungstenite::Message as ClientMessage;

    const BOUND: Duration = Duration::from_secs(3);
    const GET_HEALTH: &[u8] = b"GET /health HTTP/1.1\r\nHost: localhost\r\n\r\n";
    const GET_SLOW: &[u8] = b"GET /slow HTTP/1.1
Host: localhost

";
    const GET_DENIED: &[u8] = b"GET /denied HTTP/1.1\r\nHost: localhost\r\n\r\n";

    async fn ws_echo(ws: WebSocketUpgrade) -> impl IntoResponse {
        ws.on_upgrade(|mut socket| async move {
            while let Some(Ok(msg)) = socket.recv().await {
                if socket.send(msg).await.is_err() {
                    break;
                }
            }
        })
    }

    /// An endless response body, like an SSE stream whose client stopped reading.
    async fn flood() -> Body {
        Body::from_stream(futures::stream::repeat_with(|| {
            Ok::<_, std::convert::Infallible>(Bytes::from(vec![b'x'; 65536]))
        }))
    }

    async fn spawn(limits: ServeLimits) -> SocketAddr {
        let app = Router::new()
            .route("/health", get(|| async { "OK" }))
            .route(
                "/slow",
                get(|| async {
                    tokio::time::sleep(Duration::from_millis(600)).await;
                    "slow-done"
                }),
            )
            .route("/denied", get(|| async { StatusCode::UNAUTHORIZED }))
            .route("/ws", get(ws_echo))
            .route("/flood", get(flood));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { serve_limited(listener, app, limits).await });
        addr
    }

    /// Send one request on `c` and return the status line.
    async fn request(c: &mut TcpStream, raw: &[u8]) -> String {
        c.write_all(raw).await.unwrap();
        let mut buf = [0u8; 1024];
        let n = tokio::time::timeout(BOUND, c.read(&mut buf))
            .await
            .expect("no answer")
            .unwrap();
        String::from_utf8_lossy(&buf[..n])
            .lines()
            .next()
            .unwrap_or("")
            .to_string()
    }

    /// True when the server closed `c` (end of stream or reset) within the bound.
    async fn closed_by_server(c: &mut TcpStream) -> bool {
        let mut buf = [0u8; 64];
        let read = tokio::time::timeout(BOUND, c.read(&mut buf)).await;
        matches!(read, Ok(Ok(0)) | Ok(Err(_)))
    }

    #[tokio::test]
    async fn idle_sockets_cannot_starve_a_real_client() {
        let addr = spawn(ServeLimits {
            header_read_timeout: Duration::from_secs(60),
            max_connections: 4,
            ..ServeLimits::DEFAULT
        })
        .await;
        // Four sockets that connect and send nothing take every slot.
        let mut idle = Vec::new();
        for _ in 0..4 {
            idle.push(TcpStream::connect(addr).await.unwrap());
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
        let mut real = TcpStream::connect(addr).await.unwrap();
        assert_eq!(request(&mut real, GET_HEALTH).await, "HTTP/1.1 200 OK");
        // The oldest idle socket is the one that was closed to make room.
        assert!(closed_by_server(&mut idle[0]).await);
    }

    #[tokio::test]
    async fn refused_connections_are_evicted_before_served_ones() {
        let addr = spawn(ServeLimits {
            header_read_timeout: Duration::from_secs(60),
            max_connections: 3,
            ..ServeLimits::DEFAULT
        })
        .await;
        let mut served = TcpStream::connect(addr).await.unwrap();
        assert_eq!(request(&mut served, GET_HEALTH).await, "HTTP/1.1 200 OK");
        // Two connections whose only request is refused still count as unproven.
        let mut refused_a = TcpStream::connect(addr).await.unwrap();
        assert_eq!(
            request(&mut refused_a, GET_DENIED).await,
            "HTTP/1.1 401 Unauthorized"
        );
        let mut refused_b = TcpStream::connect(addr).await.unwrap();
        assert_eq!(
            request(&mut refused_b, GET_DENIED).await,
            "HTTP/1.1 401 Unauthorized"
        );
        let mut real = TcpStream::connect(addr).await.unwrap();
        assert_eq!(request(&mut real, GET_HEALTH).await, "HTTP/1.1 200 OK");
        assert!(closed_by_server(&mut refused_a).await);
        // The served connection is still open and answers.
        assert_eq!(request(&mut served, GET_HEALTH).await, "HTTP/1.1 200 OK");
    }

    #[tokio::test]
    async fn idle_keepalive_connections_that_were_served_cannot_fill_the_cap() {
        let addr = spawn(ServeLimits {
            header_read_timeout: Duration::from_secs(60),
            max_connections: 3,
            ..ServeLimits::DEFAULT
        })
        .await;
        // Every slot is taken by a connection that already got a 200 and now sits idle (keep-alive).
        let mut served = Vec::new();
        for _ in 0..3 {
            let mut c = TcpStream::connect(addr).await.unwrap();
            assert_eq!(request(&mut c, GET_HEALTH).await, "HTTP/1.1 200 OK");
            served.push(c);
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
        let mut real = TcpStream::connect(addr).await.unwrap();
        assert_eq!(request(&mut real, GET_HEALTH).await, "HTTP/1.1 200 OK");
        // The oldest idle connection is the one that made room.
        assert!(closed_by_server(&mut served[0]).await);
    }

    #[tokio::test]
    async fn a_request_in_flight_is_never_evicted() {
        let addr = spawn(ServeLimits {
            header_read_timeout: Duration::from_secs(60),
            max_connections: 1,
            ..ServeLimits::DEFAULT
        })
        .await;
        let mut busy = TcpStream::connect(addr).await.unwrap();
        busy.write_all(GET_SLOW).await.unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;
        // A second client arrives while the slow request is still being handled.
        let second = tokio::spawn(async move {
            let mut c = TcpStream::connect(addr).await.unwrap();
            request(&mut c, GET_HEALTH).await
        });
        let mut buf = [0u8; 1024];
        let n = tokio::time::timeout(BOUND, busy.read(&mut buf))
            .await
            .expect("the in-flight request was cut")
            .unwrap();
        let text = String::from_utf8_lossy(&buf[..n]).to_string();
        assert!(text.starts_with("HTTP/1.1 200 OK"), "got: {text}");
        assert!(text.contains("slow-done"), "the response was cut: {text}");
        // Once the slow request ended, the newcomer takes the slot.
        assert_eq!(second.await.unwrap(), "HTTP/1.1 200 OK");
    }

    #[tokio::test]
    async fn an_idle_websocket_session_is_closed_after_the_idle_time() {
        let addr = spawn(ServeLimits {
            session_idle_timeout: Duration::from_millis(400),
            ..ServeLimits::DEFAULT
        })
        .await;
        let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/ws"))
            .await
            .unwrap();
        // A session that keeps sending stays open past the idle time.
        for i in 0..8 {
            ws.send(ClientMessage::Text(format!("ping {i}").into()))
                .await
                .unwrap();
            let echoed = tokio::time::timeout(BOUND, ws.next()).await.unwrap();
            assert!(matches!(echoed, Some(Ok(ClientMessage::Text(_)))));
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        // Then it goes quiet and the server closes it.
        let start = StdInstant::now();
        let end = tokio::time::timeout(BOUND, async {
            loop {
                match ws.next().await {
                    None | Some(Err(_)) | Some(Ok(ClientMessage::Close(_))) => break,
                    Some(Ok(_)) => continue,
                }
            }
        })
        .await;
        assert!(end.is_ok(), "the idle session was not closed");
        assert!(start.elapsed() < BOUND);
    }

    #[tokio::test]
    async fn a_client_that_stops_reading_is_cut_after_the_write_timeout() {
        let addr = spawn(ServeLimits {
            write_timeout: Duration::from_millis(300),
            ..ServeLimits::DEFAULT
        })
        .await;
        let mut c = TcpStream::connect(addr).await.unwrap();
        c.write_all(b"GET /flood HTTP/1.1\r\nHost: localhost\r\n\r\n")
            .await
            .unwrap();
        // Do not read: the server's writes block once the socket buffers are full.
        tokio::time::sleep(Duration::from_millis(900)).await;
        // Drain what was buffered: with the cut it ends; an endless stream would not.
        let mut buf = vec![0u8; 65536];
        let drained = tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                match c.read(&mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {}
                }
            }
        })
        .await;
        assert!(drained.is_ok(), "the stalled connection was not closed");
    }

    #[test]
    fn server_settings_map_to_limits_and_zero_keeps_the_default() {
        let cfg = crate::config::ServerConfig {
            write_timeout_secs: 5,
            session_idle_timeout_secs: 0,
            ..crate::config::ServerConfig::default()
        };
        let l = ServeLimits::from_server(&cfg);
        assert_eq!(l.write_timeout, Duration::from_secs(5));
        assert_eq!(l.session_idle_timeout, SESSION_IDLE_TIMEOUT);
        let d = ServeLimits::from_server(&crate::config::ServerConfig::default());
        assert_eq!(d.write_timeout, WRITE_TIMEOUT);
        assert_eq!(d.session_idle_timeout, SESSION_IDLE_TIMEOUT);
    }
}
