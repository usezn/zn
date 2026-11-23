//! Helpers shared by unit tests in this crate. Compiled only under `cfg(test)`.

use std::path::Path;
use std::sync::{Mutex, MutexGuard};

use crate::ai::embedder::Embedder;

/// Serializes every test that sets or reads a process-wide environment variable
/// (HOME, USERPROFILE, ZN_PORT, ...). Hold the guard for the whole test.
pub(crate) fn env_lock() -> MutexGuard<'static, ()> {
    static ENV_LOCK: Mutex<()> = Mutex::new(());
    ENV_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// True when the error is a transport failure (no network, DNS, connection refused) while
/// fetching the model, as opposed to the server answering with an HTTP error status.
fn is_offline_error(err: &anyhow::Error) -> bool {
    let text = format!("{err:#}");
    text.starts_with("downloading ") && !text.contains("HTTP status")
}

/// Loads the embedding model into `dir` for a test. The test is skipped, with a visible
/// `SKIPPED` line, only when the model cannot be fetched because the machine is offline:
/// either `ZN_TEST_OFFLINE=1` is set, or the failure is a transport error and `CI` is not
/// set. In CI an unavailable model fails the test, and an HTTP error status (bad URL, 404,
/// 500) or a hash mismatch always fails it.
pub(crate) fn embedder_or_skip(dir: &Path, cache_ttl: Option<u64>) -> Option<Embedder> {
    let loaded = match cache_ttl {
        Some(ttl) => Embedder::with_cache(dir, ttl),
        None => Embedder::new(dir),
    };
    match loaded {
        Ok(embedder) => Some(embedder),
        Err(err) if is_offline_error(&err) => {
            let forced = std::env::var("ZN_TEST_OFFLINE").is_ok_and(|v| v == "1");
            let in_ci = std::env::var_os("CI").is_some();
            if forced || !in_ci {
                eprintln!(
                    "SKIPPED: model-backed test not run, embedding model unreachable (offline): {err}"
                );
                None
            } else {
                panic!("model must load in CI (set ZN_TEST_OFFLINE=1 to skip when offline): {err}")
            }
        }
        Err(err) => panic!("model must load: {err}"),
    }
}
