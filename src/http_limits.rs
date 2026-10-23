//! Limits for the management API's HTTP server: how long a client may take to send its headers and body,
//! and how many connections are served at once.
//!
//! `axum::serve` sets none of these, so a client that sends half a request and goes silent (or opens a few
//! hundred idle sockets) held a connection, and a file descriptor, for as long as it liked. This module
//! runs the same router on hyper directly, with the three limits applied.

use axum::{
    body::Body,
    extract::{ConnectInfo, Request, State},
    middleware::{self, Next},
    response::Response,
    Extension, Router,
};
use hyper::server::conn::http1;
use hyper_util::{
    rt::{TokioIo, TokioTimer},
    service::TowerToHyperService,
};
use std::{net::SocketAddr, sync::Arc, time::Duration};
use tokio::{net::TcpListener, sync::Semaphore};
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

/// Serve `app` on `listener` until the task is dropped. Handlers still see `ConnectInfo<SocketAddr>`.
pub async fn serve_limited(listener: TcpListener, app: Router, limits: ServeLimits) {
    let app = app.layer(middleware::from_fn_with_state(
        limits.body_idle_timeout,
        body_idle_timeout,
    ));
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
        let service = TowerToHyperService::new(
            app.clone()
                .layer(Extension(ConnectInfo::<SocketAddr>(remote))),
        );
        tokio::spawn(async move {
            // The slot is held until the connection ends, a WebSocket session included.
            let _permit = permit;
            let conn = http1::Builder::new()
                .timer(TokioTimer::new())
                .header_read_timeout(limits.header_read_timeout)
                .serve_connection(TokioIo::new(stream), service)
                .with_upgrades();
            if let Err(e) = conn.await {
                tracing::debug!("Management API connection ended: {}", e);
            }
        });
    }
}
