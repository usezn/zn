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

/// Loads the embedding model into `dir` for a test. When the model cannot be
/// downloaded (offline sandbox, Hugging Face unreachable) the test is skipped
/// with a message. Any other failure, such as a hash mismatch, fails the test.
pub(crate) fn embedder_or_skip(dir: &Path, cache_ttl: Option<u64>) -> Option<Embedder> {
    let loaded = match cache_ttl {
        Some(ttl) => Embedder::with_cache(dir, ttl),
        None => Embedder::new(dir),
    };
    match loaded {
        Ok(embedder) => Some(embedder),
        Err(err) if err.to_string().starts_with("downloading ") => {
            eprintln!(
                "SKIP: embedding model unavailable (offline or Hugging Face unreachable): {err}"
            );
            None
        }
        Err(err) => panic!("model must load: {err}"),
    }
}
