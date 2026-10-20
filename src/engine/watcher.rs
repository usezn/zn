//! Policy Watcher Module
//!
//! Monitors the policy directory for changes and triggers reloads
//! in the ZnEngine automatically.

use crate::engine::ZnEngine;
use crossbeam_channel::{unbounded, Receiver};
use notify::{Config, Event, RecursiveMode, Watcher};
use std::path::PathBuf;
use std::sync::Arc;
use tracing::{error, info};

pub struct PolicyWatcher {
    #[allow(dead_code)]
    watcher: notify::RecommendedWatcher,
    engine: Arc<ZnEngine>,
    #[allow(dead_code)]
    policy_dir: PathBuf,
}

impl PolicyWatcher {
    /// Create a new PolicyWatcher
    pub fn new(engine: Arc<ZnEngine>, policy_dir: impl Into<PathBuf>) -> anyhow::Result<Self> {
        let policy_dir = policy_dir.into();
        let (tx, rx) = unbounded();

        let mut watcher = notify::RecommendedWatcher::new(
            move |res| {
                if let Ok(event) = res {
                    let _ = tx.send(event);
                }
            },
            Config::default(),
        )?;

        watcher.watch(&policy_dir, RecursiveMode::NonRecursive)?;

        let watcher_instance = Self {
            watcher,
            engine,
            policy_dir,
        };

        // Spawn the event handler loop
        watcher_instance.spawn_handler(rx);

        Ok(watcher_instance)
    }

    fn spawn_handler(&self, rx: Receiver<Event>) {
        let engine = Arc::clone(&self.engine);

        tokio::spawn(async move {
            info!("Policy watcher started. Monitoring for changes...");

            while let Ok(event) = rx.recv() {
                if event.kind.is_modify() || event.kind.is_create() {
                    for path in event.paths {
                        if path.extension().is_some_and(|ext| ext == "wasm") {
                            info!("Policy change detected: {:?}", path);
                            // Give some time for the file to be fully written
                            tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;

                            if let Err(e) = engine.register_policy_from_file(&path) {
                                error!("Failed to reload policy {:?}: {}", path, e);
                            } else {
                                info!("Policy successfully reloaded: {:?}", path);
                            }
                        }
                    }
                } else if event.kind.is_remove() {
                    for path in event.paths {
                        if let Some(name) = path.file_stem().and_then(|s| s.to_str()) {
                            engine.unregister_policy(name);
                        }
                    }
                }
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::ZnEngineConfig;

    fn test_engine() -> Arc<ZnEngine> {
        Arc::new(
            ZnEngine::new(ZnEngineConfig {
                gas_limit: 10_000_000,
                memory_limit: 10 * 1024 * 1024,
                timeout_ms: 50,
                allowed_hashes: vec![],
                signing_public_key: None,
            })
            .expect("engine init"),
        )
    }

    #[test]
    fn watching_a_missing_directory_fails() {
        let dir = tempfile::tempdir().expect("tempdir");
        let missing = dir.path().join("does-not-exist");
        assert!(PolicyWatcher::new(test_engine(), missing).is_err());
    }

    #[tokio::test]
    async fn watching_an_existing_directory_starts() {
        let dir = tempfile::tempdir().expect("tempdir");
        let watcher = PolicyWatcher::new(test_engine(), dir.path());
        assert!(watcher.is_ok());
    }

    // ----- reload behavior ---------------------------------------------------
    //
    // The handler task blocks on a channel `recv()`, so these tests use a
    // multi-thread runtime (a current-thread one would never get to poll the
    // test body). Polling uses std sleeps, not tokio timers: the blocked handler
    // can starve the runtime timer driver and hang the test. Waits are bounded
    // polling loops, never fixed sleeps, except
    // for the negative checks, which always end with a positive control event:
    // events are handled in order, so once the control is seen every earlier
    // event has been handled too.

    /// Smallest valid WebAssembly module.
    const EMPTY_WASM: &[u8] = b"\0asm\x01\0\0\0";
    /// Same module plus a custom section, so its bytes (and hash) differ.
    const OTHER_WASM: &[u8] = b"\0asm\x01\0\0\0\0\x03\x02ab";

    const WAIT: std::time::Duration = std::time::Duration::from_secs(5);

    fn wait_until(what: &str, mut cond: impl FnMut() -> bool) {
        let deadline = std::time::Instant::now() + WAIT;
        while !cond() {
            assert!(
                std::time::Instant::now() < deadline,
                "timed out after {WAIT:?} waiting for: {what}"
            );
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
    }

    fn sha256_hex(data: &[u8]) -> String {
        use sha2::{Digest, Sha256};
        hex::encode(Sha256::digest(data))
    }

    fn engine_allowing_only(data: &[u8]) -> Arc<ZnEngine> {
        Arc::new(
            ZnEngine::new(ZnEngineConfig {
                gas_limit: 10_000_000,
                memory_limit: 10 * 1024 * 1024,
                timeout_ms: 50,
                allowed_hashes: vec![sha256_hex(data)],
                signing_public_key: None,
            })
            .expect("engine init"),
        )
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn creating_a_wasm_file_registers_the_policy() {
        let dir = tempfile::tempdir().expect("tempdir");
        let engine = test_engine();
        let _watcher = PolicyWatcher::new(Arc::clone(&engine), dir.path()).expect("watcher");

        std::fs::write(dir.path().join("alpha.wasm"), EMPTY_WASM).unwrap();

        wait_until("alpha registered", || engine._has_policy("alpha"));
        assert_eq!(engine.list_policies(), vec!["alpha".to_string()]);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn modifying_a_wasm_file_reloads_it() {
        let dir = tempfile::tempdir().expect("tempdir");
        // Only OTHER_WASM passes the integrity check, so the initial write is
        // rejected and only the modification can register the policy.
        let engine = engine_allowing_only(OTHER_WASM);
        let _watcher = PolicyWatcher::new(Arc::clone(&engine), dir.path()).expect("watcher");
        let path = dir.path().join("beta.wasm");

        std::fs::write(&path, EMPTY_WASM).unwrap();
        // Positive control for the rejected write: a second file that is allowed.
        std::fs::write(dir.path().join("control.wasm"), OTHER_WASM).unwrap();
        wait_until("control registered", || engine._has_policy("control"));
        assert!(
            !engine._has_policy("beta"),
            "a policy with a disallowed hash must not load"
        );

        std::fs::write(&path, OTHER_WASM).unwrap();
        wait_until("beta registered after modification", || {
            engine._has_policy("beta")
        });
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn deleting_a_wasm_file_unregisters_the_policy() {
        let dir = tempfile::tempdir().expect("tempdir");
        let engine = test_engine();
        let _watcher = PolicyWatcher::new(Arc::clone(&engine), dir.path()).expect("watcher");
        let path = dir.path().join("gamma.wasm");

        std::fs::write(&path, EMPTY_WASM).unwrap();
        wait_until("gamma registered", || engine._has_policy("gamma"));

        std::fs::remove_file(&path).unwrap();
        wait_until("gamma unregistered", || !engine._has_policy("gamma"));
        assert_eq!(engine.policy_count(), 0);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn an_invalid_wasm_file_is_not_registered_and_does_not_stop_the_watcher() {
        let dir = tempfile::tempdir().expect("tempdir");
        let engine = test_engine();
        let _watcher = PolicyWatcher::new(Arc::clone(&engine), dir.path()).expect("watcher");

        std::fs::write(dir.path().join("broken.wasm"), b"not wasm").unwrap();
        std::fs::write(dir.path().join("good.wasm"), EMPTY_WASM).unwrap();

        wait_until("good registered", || engine._has_policy("good"));
        assert!(!engine._has_policy("broken"));
        assert_eq!(engine.policy_count(), 1);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn files_without_the_wasm_extension_do_not_trigger_a_reload() {
        let dir = tempfile::tempdir().expect("tempdir");
        let engine = test_engine();
        let _watcher = PolicyWatcher::new(Arc::clone(&engine), dir.path()).expect("watcher");

        // Valid module bytes under other names/extensions must be ignored.
        std::fs::write(dir.path().join("notes.txt"), EMPTY_WASM).unwrap();
        std::fs::write(dir.path().join("policy.wasm.bak"), EMPTY_WASM).unwrap();
        std::fs::write(dir.path().join("noext"), EMPTY_WASM).unwrap();
        // Positive control.
        std::fs::write(dir.path().join("control.wasm"), EMPTY_WASM).unwrap();

        wait_until("control registered", || engine._has_policy("control"));
        assert_eq!(engine.list_policies(), vec!["control".to_string()]);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn events_in_another_directory_do_not_trigger_a_reload() {
        let watched = tempfile::tempdir().expect("tempdir");
        let other = tempfile::tempdir().expect("tempdir");
        let engine = test_engine();
        let _watcher = PolicyWatcher::new(Arc::clone(&engine), watched.path()).expect("watcher");

        std::fs::write(other.path().join("foreign.wasm"), EMPTY_WASM).unwrap();
        // Positive control in the watched directory.
        std::fs::write(watched.path().join("control.wasm"), EMPTY_WASM).unwrap();

        wait_until("control registered", || engine._has_policy("control"));
        assert!(!engine._has_policy("foreign"));
        assert_eq!(engine.policy_count(), 1);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn files_in_subdirectories_are_not_watched() {
        // The watch is NonRecursive: a policy in a nested directory is ignored.
        let dir = tempfile::tempdir().expect("tempdir");
        let nested = dir.path().join("nested");
        std::fs::create_dir(&nested).unwrap();
        let engine = test_engine();
        let _watcher = PolicyWatcher::new(Arc::clone(&engine), dir.path()).expect("watcher");

        std::fs::write(nested.join("deep.wasm"), EMPTY_WASM).unwrap();
        std::fs::write(dir.path().join("control.wasm"), EMPTY_WASM).unwrap();

        wait_until("control registered", || engine._has_policy("control"));
        assert!(!engine._has_policy("deep"));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_file_path_instead_of_a_directory_is_handled() {
        // Watching a regular file is accepted by the OS; the constructor must
        // not panic, and nothing is registered for it.
        let dir = tempfile::tempdir().expect("tempdir");
        let file = dir.path().join("plain.txt");
        std::fs::write(&file, b"x").unwrap();
        let engine = test_engine();
        let _ = PolicyWatcher::new(Arc::clone(&engine), &file);
        assert_eq!(engine.policy_count(), 0);
    }
}
