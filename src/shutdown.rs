//! Stopping the gateway on a signal.
//!
//! `zn start` runs until its input closes. Without this, Ctrl+C or `kill` ended the process at
//! once and any MCP server it had started over stdio was left running on its own. The gateway
//! now waits for the request it is handling, stops those servers, and exits with the code a shell
//! expects after a signal: 130 after Ctrl+C (SIGINT) and 143 after SIGTERM (`128 + signal`).
//! Every audit entry is written to SQLite in its own transaction before the request is answered,
//! so there is nothing buffered to flush: stopping between requests loses no line.

use crate::proxy::McpPool;
use std::time::Duration;

/// How long to wait for MCP servers to stop before the gateway exits anyway.
pub const CHILD_STOP_TIMEOUT: Duration = Duration::from_secs(5);

/// The signal that asked the gateway to stop.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopSignal {
    /// Ctrl+C (SIGINT on Unix, Ctrl+C on Windows).
    Interrupt,
    /// SIGTERM, as sent by `kill`, `docker stop` and service managers; on Windows, closing the console.
    Terminate,
}

impl StopSignal {
    /// The process exit code for this signal.
    pub fn exit_code(self) -> i32 {
        match self {
            StopSignal::Interrupt => 130,
            StopSignal::Terminate => 143,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            StopSignal::Interrupt => "interrupt",
            StopSignal::Terminate => "terminate",
        }
    }
}

/// Handlers for the stop signals. Install them before any work starts, so a signal that
/// arrives early is queued instead of ending the process.
pub struct StopSignals {
    #[cfg(unix)]
    interrupt: tokio::signal::unix::Signal,
    #[cfg(unix)]
    terminate: tokio::signal::unix::Signal,
    #[cfg(windows)]
    ctrl_c: tokio::signal::windows::CtrlC,
    #[cfg(windows)]
    ctrl_close: tokio::signal::windows::CtrlClose,
}

impl StopSignals {
    #[cfg(unix)]
    pub fn install() -> std::io::Result<Self> {
        use tokio::signal::unix::{signal, SignalKind};
        Ok(Self {
            interrupt: signal(SignalKind::interrupt())?,
            terminate: signal(SignalKind::terminate())?,
        })
    }

    #[cfg(windows)]
    pub fn install() -> std::io::Result<Self> {
        Ok(Self {
            ctrl_c: tokio::signal::windows::ctrl_c()?,
            ctrl_close: tokio::signal::windows::ctrl_close()?,
        })
    }

    /// Wait for the next stop signal. Safe to use in `select!`: a signal is never lost.
    #[cfg(unix)]
    pub async fn recv(&mut self) -> StopSignal {
        tokio::select! {
            _ = self.interrupt.recv() => StopSignal::Interrupt,
            _ = self.terminate.recv() => StopSignal::Terminate,
        }
    }

    #[cfg(windows)]
    pub async fn recv(&mut self) -> StopSignal {
        tokio::select! {
            _ = self.ctrl_c.recv() => StopSignal::Interrupt,
            _ = self.ctrl_close.recv() => StopSignal::Terminate,
        }
    }
}

/// Stop every MCP server the pool started. Returns false if they did not stop within `limit`
/// (a request still holding a server's connection keeps it from being closed).
pub async fn stop_children(pool: &McpPool, limit: Duration) -> bool {
    tokio::time::timeout(limit, pool.shutdown_all())
        .await
        .is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exit_codes_follow_the_shell_convention() {
        assert_eq!(StopSignal::Interrupt.exit_code(), 130);
        assert_eq!(StopSignal::Terminate.exit_code(), 143);
    }

    #[tokio::test]
    async fn stopping_an_empty_pool_succeeds() {
        let pool = McpPool::new(std::collections::HashMap::new());
        assert!(stop_children(&pool, Duration::from_secs(1)).await);
    }
}
