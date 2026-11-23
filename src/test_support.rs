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

/// Sets (or removes, with `None`) a process-wide environment variable and restores the
/// previous value, or removes it if it was unset, when dropped. Hold `env_lock()` for the
/// whole test.
pub(crate) struct EnvRestore {
    key: &'static str,
    previous: Option<std::ffi::OsString>,
}

impl EnvRestore {
    pub(crate) fn set(key: &'static str, value: Option<&str>) -> Self {
        let previous = std::env::var_os(key);
        match value {
            Some(v) => std::env::set_var(key, v),
            None => std::env::remove_var(key),
        }
        EnvRestore { key, previous }
    }
}

impl Drop for EnvRestore {
    fn drop(&mut self) {
        match &self.previous {
            Some(v) => std::env::set_var(self.key, v),
            None => std::env::remove_var(self.key),
        }
    }
}

/// Loads the embedding model into `dir` for a test. The model must be available: any
/// failure to load it fails the test, so a missing model never passes silently. The one
/// exception is an explicit opt-in on machines without network access: with
/// `ZN_TEST_OFFLINE=1` a failed model download skips the model-backed test, and a
/// `SKIPPED` line is printed (visible with `cargo test -- --nocapture`). HTTP errors and
/// hash mismatches always fail.
pub(crate) fn embedder_or_skip(dir: &Path, cache_ttl: Option<u64>) -> Option<Embedder> {
    let loaded = match cache_ttl {
        Some(ttl) => Embedder::with_cache(dir, ttl),
        None => Embedder::new(dir),
    };
    match loaded {
        Ok(embedder) => Some(embedder),
        Err(err) => {
            let text = format!("{err:#}");
            let transport = text.starts_with("downloading ") && !text.contains("HTTP status");
            if transport && std::env::var("ZN_TEST_OFFLINE").is_ok_and(|v| v == "1") {
                println!("SKIPPED: model-backed test not run (ZN_TEST_OFFLINE=1, model unreachable): {err}");
                None
            } else {
                panic!("model must load (set ZN_TEST_OFFLINE=1 to skip when offline): {err}")
            }
        }
    }
}
