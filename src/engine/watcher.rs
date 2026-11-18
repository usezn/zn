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
                        // Only a removed `.wasm` file unregisters a policy: deleting
                        // `alpha.txt` must not drop the policy loaded from `alpha.wasm`.
                        if !path.extension().is_some_and(|ext| ext == "wasm") {
                            continue;
                        }
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

    // ----- late directory, invalid replacement, removal, bursts, shutdown ------

    /// Collects what the watcher logs, so a test can check that an error is reported.
    struct SharedBuf(Arc<std::sync::Mutex<Vec<u8>>>);

    impl std::io::Write for SharedBuf {
        fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(b);
            Ok(b.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    /// Installs (once per test binary) a global subscriber that records every
    /// event. The handler task runs on another thread, so a thread-local
    /// subscriber would not see its logs.
    fn log_capture() -> Arc<std::sync::Mutex<Vec<u8>>> {
        static LOGS: std::sync::OnceLock<Arc<std::sync::Mutex<Vec<u8>>>> =
            std::sync::OnceLock::new();
        Arc::clone(LOGS.get_or_init(|| {
            let buf = Arc::new(std::sync::Mutex::new(Vec::new()));
            let writer = Arc::clone(&buf);
            let subscriber = tracing_subscriber::fmt()
                .with_ansi(false)
                .with_writer(move || SharedBuf(Arc::clone(&writer)))
                .finish();
            tracing::subscriber::set_global_default(subscriber)
                .expect("no other test installs a global tracing subscriber");
            buf
        }))
    }

    fn logged(buf: &Arc<std::sync::Mutex<Vec<u8>>>) -> String {
        String::from_utf8_lossy(&buf.lock().unwrap()).to_string()
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_policy_directory_that_appears_late_can_be_watched_afterwards() {
        let root = tempfile::tempdir().expect("tempdir");
        let policy_dir = root.path().join("policies");
        let engine = test_engine();

        // The directory does not exist yet: the watcher cannot start.
        assert!(PolicyWatcher::new(Arc::clone(&engine), &policy_dir).is_err());
        assert_eq!(engine.policy_count(), 0);

        // Once the directory exists a new watcher starts and sees new files.
        std::fs::create_dir(&policy_dir).unwrap();
        let _watcher = PolicyWatcher::new(Arc::clone(&engine), &policy_dir).expect("watcher");
        std::fs::write(policy_dir.join("late.wasm"), EMPTY_WASM).unwrap();
        wait_until("late registered", || engine._has_policy("late"));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn files_already_in_the_directory_are_not_loaded_by_the_watcher_itself() {
        // The watcher reacts to changes only; the initial load is the
        // engine's `load_all_policies`. A file present before start-up stays
        // unregistered until it changes.
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(dir.path().join("before.wasm"), EMPTY_WASM).unwrap();
        let engine = test_engine();
        let _watcher = PolicyWatcher::new(Arc::clone(&engine), dir.path()).expect("watcher");

        std::fs::write(dir.path().join("control.wasm"), EMPTY_WASM).unwrap();
        wait_until("control registered", || engine._has_policy("control"));
        assert!(!engine._has_policy("before"));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn an_invalid_replacement_keeps_the_previous_policy_and_reports_the_error() {
        let logs = log_capture();
        let dir = tempfile::tempdir().expect("tempdir");
        let engine = test_engine();
        let _watcher = PolicyWatcher::new(Arc::clone(&engine), dir.path()).expect("watcher");
        let path = dir.path().join("reportme.wasm");

        std::fs::write(&path, EMPTY_WASM).unwrap();
        wait_until("reportme registered", || engine._has_policy("reportme"));
        let before = engine._get_policy("reportme").expect("registered module");

        // Replace the file with bytes that are not a WebAssembly module.
        std::fs::write(&path, b"this is not a wasm module").unwrap();
        // Positive control: events are handled in order, so once it is
        // registered the invalid write has been handled too.
        std::fs::write(dir.path().join("control.wasm"), EMPTY_WASM).unwrap();
        wait_until("control registered", || engine._has_policy("control"));

        assert!(engine._has_policy("reportme"), "the old policy must stay");
        let after = engine._get_policy("reportme").unwrap();
        assert!(Arc::ptr_eq(&before, &after), "the module was not replaced");

        let out = logged(&logs);
        let reported = out
            .lines()
            .any(|l| l.contains("Failed to reload policy") && l.contains("reportme.wasm"));
        assert!(reported, "the failed reload must be logged, got:\n{out}");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_valid_replacement_swaps_the_module() {
        let dir = tempfile::tempdir().expect("tempdir");
        let both = vec![sha256_hex(EMPTY_WASM), sha256_hex(OTHER_WASM)];
        let engine = Arc::new(
            ZnEngine::new(ZnEngineConfig {
                gas_limit: 10_000_000,
                memory_limit: 10 * 1024 * 1024,
                timeout_ms: 50,
                allowed_hashes: both,
                signing_public_key: None,
            })
            .expect("engine init"),
        );
        let _watcher = PolicyWatcher::new(Arc::clone(&engine), dir.path()).expect("watcher");
        let path = dir.path().join("swap.wasm");

        std::fs::write(&path, EMPTY_WASM).unwrap();
        wait_until("swap registered", || engine._has_policy("swap"));
        let first = engine._get_policy("swap").unwrap();

        std::fs::write(&path, OTHER_WASM).unwrap();
        wait_until("swap replaced", || {
            engine
                ._get_policy("swap")
                .is_some_and(|m| !Arc::ptr_eq(&m, &first))
        });
        assert_eq!(engine.policy_count(), 1);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn removing_a_wasm_file_that_was_never_registered_is_harmless() {
        let dir = tempfile::tempdir().expect("tempdir");
        let engine = engine_allowing_only(OTHER_WASM);
        let _watcher = PolicyWatcher::new(Arc::clone(&engine), dir.path()).expect("watcher");
        let ghost = dir.path().join("ghost.wasm");

        // Rejected by the allowed-hash list, then removed.
        std::fs::write(&ghost, EMPTY_WASM).unwrap();
        std::fs::remove_file(&ghost).unwrap();
        std::fs::write(dir.path().join("control.wasm"), OTHER_WASM).unwrap();

        wait_until("control registered", || engine._has_policy("control"));
        assert_eq!(engine.list_policies(), vec!["control".to_string()]);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn removing_one_policy_leaves_the_others() {
        let dir = tempfile::tempdir().expect("tempdir");
        let engine = test_engine();
        let _watcher = PolicyWatcher::new(Arc::clone(&engine), dir.path()).expect("watcher");

        std::fs::write(dir.path().join("keep.wasm"), EMPTY_WASM).unwrap();
        std::fs::write(dir.path().join("drop-me.wasm"), EMPTY_WASM).unwrap();
        wait_until("both registered", || engine.policy_count() == 2);

        std::fs::remove_file(dir.path().join("drop-me.wasm")).unwrap();
        wait_until("drop-me gone", || !engine._has_policy("drop-me"));
        assert!(engine._has_policy("keep"));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn removing_a_file_with_another_extension_keeps_the_policy_of_the_same_name() {
        let dir = tempfile::tempdir().expect("tempdir");
        let engine = test_engine();
        let _watcher = PolicyWatcher::new(Arc::clone(&engine), dir.path()).expect("watcher");

        std::fs::write(dir.path().join("alpha.wasm"), EMPTY_WASM).unwrap();
        wait_until("alpha registered", || engine._has_policy("alpha"));

        // A sidecar file with the same stem is created and deleted.
        let sidecar = dir.path().join("alpha.txt");
        std::fs::write(&sidecar, b"notes").unwrap();
        std::fs::remove_file(&sidecar).unwrap();
        // Positive control, handled after the removal event.
        std::fs::write(dir.path().join("control.wasm"), EMPTY_WASM).unwrap();
        wait_until("control registered", || engine._has_policy("control"));

        assert!(
            engine._has_policy("alpha"),
            "deleting alpha.txt must not unregister the policy alpha.wasm"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn rapid_successive_writes_end_with_the_last_valid_content() {
        let dir = tempfile::tempdir().expect("tempdir");
        // Only OTHER_WASM is allowed: the EMPTY_WASM writes are rejected.
        let engine = engine_allowing_only(OTHER_WASM);
        let _watcher = PolicyWatcher::new(Arc::clone(&engine), dir.path()).expect("watcher");
        let path = dir.path().join("burst.wasm");

        for i in 0..20 {
            let bytes = if i % 2 == 0 { OTHER_WASM } else { EMPTY_WASM };
            std::fs::write(&path, bytes).unwrap();
        }
        // The loop ends on a rejected write (i = 19 is EMPTY); finish with a valid one.
        std::fs::write(&path, OTHER_WASM).unwrap();
        std::fs::write(dir.path().join("control.wasm"), OTHER_WASM).unwrap();

        wait_until("control registered", || engine._has_policy("control"));
        assert!(engine._has_policy("burst"));
        assert_eq!(
            engine.policy_count(),
            2,
            "one entry per file, not per event"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_burst_that_ends_invalid_leaves_the_previous_policy_in_place() {
        let dir = tempfile::tempdir().expect("tempdir");
        let engine = engine_allowing_only(OTHER_WASM);
        let _watcher = PolicyWatcher::new(Arc::clone(&engine), dir.path()).expect("watcher");
        let path = dir.path().join("burst.wasm");

        std::fs::write(&path, OTHER_WASM).unwrap();
        wait_until("burst registered", || engine._has_policy("burst"));
        let before = engine._get_policy("burst").unwrap();

        for _ in 0..10 {
            std::fs::write(&path, EMPTY_WASM).unwrap();
        }
        std::fs::write(dir.path().join("control.wasm"), OTHER_WASM).unwrap();
        wait_until("control registered", || engine._has_policy("control"));

        let after = engine._get_policy("burst").expect("policy still there");
        assert!(Arc::ptr_eq(&before, &after));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn dropping_the_watcher_stops_reloads() {
        let dir = tempfile::tempdir().expect("tempdir");
        let stopped_engine = test_engine();
        let live_engine = test_engine();

        let stopped = PolicyWatcher::new(Arc::clone(&stopped_engine), dir.path()).expect("w1");
        let _live = PolicyWatcher::new(Arc::clone(&live_engine), dir.path()).expect("w2");
        drop(stopped);

        std::fs::write(dir.path().join("after.wasm"), EMPTY_WASM).unwrap();
        // The second watcher sees the same event: once it has handled it, the
        // first one had the same chance to do so.
        wait_until("live watcher registered", || {
            live_engine._has_policy("after")
        });
        // Give the (stopped) handler a short bounded chance to misbehave.
        std::thread::sleep(std::time::Duration::from_millis(300));
        assert!(!stopped_engine._has_policy("after"));
        assert_eq!(stopped_engine.policy_count(), 0);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn two_watchers_on_one_directory_both_load_new_files() {
        let dir = tempfile::tempdir().expect("tempdir");
        let a = test_engine();
        let b = test_engine();
        let _wa = PolicyWatcher::new(Arc::clone(&a), dir.path()).expect("wa");
        let _wb = PolicyWatcher::new(Arc::clone(&b), dir.path()).expect("wb");

        std::fs::write(dir.path().join("shared.wasm"), EMPTY_WASM).unwrap();
        wait_until("a registered", || a._has_policy("shared"));
        wait_until("b registered", || b._has_policy("shared"));
    }
}
