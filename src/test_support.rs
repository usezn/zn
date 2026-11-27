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

/// Message for a model that could not be loaded. A missing model is always a test failure:
/// a runtime skip would show as a passing test, because stable Rust has no skipped result.
fn model_load_failure(err: &anyhow::Error) -> String {
    format!(
        "embedding model must load for this test: {err:#}
         Without network access, deselect the model-backed tests: cargo test --          --skip ai::embedder::tests::sanity_attack_vs_benign          --skip ai::embedder::tests::test_cache_          --skip batch::tests::test_batch_pipeline_with_embedder"
    )
}

/// Returns the loaded value, or panics with `model_load_failure` when loading failed. Kept
/// separate from the loader so the failure path can be tested without a network.
fn load_or_fail<T>(loaded: anyhow::Result<T>) -> T {
    loaded.unwrap_or_else(|err| panic!("{}", model_load_failure(&err)))
}

/// Loads the embedding model into `dir` for a test and panics when it cannot be loaded
/// (network failure, HTTP error, hash mismatch). Nothing is skipped silently. People without
/// network access deselect the model-backed tests explicitly, see `model_load_failure`.
pub(crate) fn embedder_or_fail(dir: &Path, cache_ttl: Option<u64>) -> Embedder {
    load_or_fail(match cache_ttl {
        Some(ttl) => Embedder::with_cache(dir, ttl),
        None => Embedder::new(dir),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[should_panic(expected = "embedding model must load")]
    fn a_transport_failure_fails_the_test_instead_of_skipping() {
        let failed: anyhow::Result<u32> = Err(anyhow::anyhow!(
            "downloading model.safetensors failed: error sending request"
        ));
        load_or_fail(failed);
    }

    #[test]
    fn a_load_failure_panics_with_the_cause_and_the_deselect_filters() {
        let failed: anyhow::Result<u32> = Err(anyhow::anyhow!("connection refused"));
        let payload = std::panic::catch_unwind(|| load_or_fail(failed))
            .expect_err("a failed load must panic, not return");
        let msg = payload
            .downcast_ref::<String>()
            .cloned()
            .expect("panic message is a String");
        assert!(msg.contains("connection refused"), "{msg}");
        assert!(msg.contains("--skip"), "{msg}");
    }

    #[test]
    fn a_successful_load_is_returned_unchanged() {
        assert_eq!(load_or_fail(Ok(7u32)), 7);
    }

    #[test]
    fn the_failure_message_names_the_cause_and_the_deselect_filters() {
        let err = anyhow::anyhow!("downloading x failed: connection refused");
        let msg = model_load_failure(&err);
        assert!(msg.contains("connection refused"), "{msg}");
        assert!(msg.contains("test_batch_pipeline_with_embedder"), "{msg}");
    }
}
