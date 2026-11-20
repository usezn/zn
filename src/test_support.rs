//! Helpers shared by the crate's unit tests.

use std::time::{Duration, Instant};

/// Poll `cond` every 10 ms until it holds. Panics with `what` once `bound` has passed, so a test waits for
/// the condition it needs instead of sleeping for a fixed time.
pub async fn wait_until(what: &str, bound: Duration, mut cond: impl FnMut() -> bool) {
    let deadline = Instant::now() + bound;
    while !cond() {
        assert!(
            Instant::now() < deadline,
            "timed out after {bound:?} waiting for: {what}"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}
