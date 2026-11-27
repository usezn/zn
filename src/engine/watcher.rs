//! Policy Watcher Module
//!
//! Monitors the policy directory for changes and triggers reloads
//! in the ZnEngine automatically.

use crate::engine::ZnEngine;
use notify::{Config, Event, RecursiveMode, Watcher};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver};
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
        let (tx, rx) = unbounded_channel();

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

    fn spawn_handler(&self, rx: UnboundedReceiver<Event>) {
        let engine = Arc::clone(&self.engine);

        tokio::spawn(async move {
            // The channel is async: a blocking `recv()` here would hold a runtime worker for the life
            // of the process, and on a one-worker runtime (1 CPU) nothing else would ever run.
            let mut rx = rx;
            info!("Policy watcher started. Monitoring for changes...");

            while let Some(event) = rx.recv().await {
                if event.kind.is_modify() || event.kind.is_create() || event.kind.is_remove() {
                    for path in event.paths {
                        match classify(&path) {
                            // A directory that happens to be named x.wasm is not a policy.
                            PolicyFile::Policy if path.is_dir() => {}
                            // Created or changed, or the target of a rename: load it.
                            PolicyFile::Policy if path.exists() => {
                                reload(&engine, &path, false).await;
                            }
                            // Deleted, or renamed away (the old path is gone): unload it unless it is
                            // the last policy and enforcement is configured.
                            PolicyFile::Policy => {
                                if let Some(name) = path.file_stem().and_then(|s| s.to_str()) {
                                    engine.unregister_policy_unless_last(name);
                                }
                            }
                            // A signature file is not the policy. The policy is verified again against
                            // the signature as it is now. With enforcement configured a policy that no
                            // longer verifies is unloaded (fail closed), unless it is the last one: then
                            // it stays loaded and the error names the reason. Without enforcement
                            // a failure is only logged and the loaded policy stays.
                            PolicyFile::Signature(policy) => {
                                if policy.is_file() {
                                    reload(&engine, &policy, true).await;
                                }
                            }
                            PolicyFile::Other => {}
                        }
                    }
                }
            }
        });
    }
}

/// What a path in the policy folder is.
enum PolicyFile {
    /// A `.wasm` policy.
    Policy,
    /// A `.wasm.sig` or `.wasm.pqs` signature, with the path of the policy it belongs to.
    Signature(PathBuf),
    Other,
}

fn classify(path: &std::path::Path) -> PolicyFile {
    let ext = path.extension().and_then(|e| e.to_str());
    match ext {
        Some("wasm") => PolicyFile::Policy,
        Some("sig") | Some("pqs") => {
            let policy = path.with_extension("");
            if policy.extension().is_some_and(|e| e == "wasm") {
                PolicyFile::Signature(policy)
            } else {
                PolicyFile::Other
            }
        }
        _ => PolicyFile::Other,
    }
}

async fn reload(engine: &ZnEngine, path: &std::path::Path, signature_event: bool) {
    info!("Policy change detected: {:?}", path);
    // Give some time for the file to be fully written
    tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;

    if let Err(e) = engine.register_policy_from_file(path) {
        error!("Failed to reload policy {:?}: {}", path, e);
        if signature_event && engine.policy_enforcement_configured() {
            if let Some(name) = path.file_stem().and_then(|s| s.to_str()) {
                engine.unregister_policy_unless_last_because(
                    name,
                    "its signature was removed or no longer verifies",
                );
            }
        }
    } else {
        info!("Policy successfully reloaded: {:?}", path);
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
    // These tests use a multi-thread runtime and poll with std sleeps, because the
    // test body blocks its own thread while it waits. Waits are bounded
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
    async fn deleting_the_last_wasm_file_keeps_it_when_enforcement_is_configured() {
        let dir = tempfile::tempdir().expect("tempdir");
        let first = dir.path().join("delta.wasm");
        let last = dir.path().join("epsilon.wasm");
        std::fs::write(&first, EMPTY_WASM).unwrap();
        std::fs::write(&last, EMPTY_WASM).unwrap();
        let engine = Arc::new(
            ZnEngine::new(ZnEngineConfig {
                gas_limit: 10_000_000,
                memory_limit: 10 * 1024 * 1024,
                timeout_ms: 50,
                allowed_hashes: vec![sha256_hex(EMPTY_WASM)],
                signing_public_key: None,
            })
            .expect("engine init"),
        );
        engine.load_all_policies(dir.path()).expect("load");
        assert_eq!(engine.policy_count(), 2);
        let _watcher = PolicyWatcher::new(Arc::clone(&engine), dir.path()).expect("watcher");
        let refusals = || {
            engine
                .kept_last_refusals
                .load(std::sync::atomic::Ordering::SeqCst)
        };

        // Positive signal that remove events are handled: deleting one of two policies removes it.
        std::fs::remove_file(&first).unwrap();
        wait_until("delta unregistered", || !engine._has_policy("delta"));
        assert_eq!(refusals(), 0);

        // Deleting the last one is observed (the removal is refused) and the policy stays registered.
        std::fs::remove_file(&last).unwrap();
        wait_until("removal of the last policy refused", || refusals() >= 1);
        assert!(engine._has_policy("epsilon"));
        assert_eq!(engine.policy_count(), 1);
    }

    fn signed_engine(sk: &ed25519_dalek::SigningKey) -> Arc<ZnEngine> {
        Arc::new(
            ZnEngine::new(ZnEngineConfig {
                gas_limit: 10_000_000,
                memory_limit: 10 * 1024 * 1024,
                timeout_ms: 50,
                allowed_hashes: vec![],
                signing_public_key: Some(hex::encode(sk.verifying_key().to_bytes())),
            })
            .expect("engine init"),
        )
    }

    fn write_signed(dir: &std::path::Path, sk: &ed25519_dalek::SigningKey, name: &str) {
        use ed25519_dalek::Signer;
        let sig = sk.sign(EMPTY_WASM);
        let b64 =
            base64::Engine::encode(&base64::engine::general_purpose::STANDARD, sig.to_bytes());
        std::fs::write(dir.join(format!("{name}.wasm.sig")), b64).unwrap();
        std::fs::write(dir.join(format!("{name}.wasm")), EMPTY_WASM).unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn deleting_a_file_that_only_shares_the_name_does_not_unregister_the_policy() {
        let dir = tempfile::tempdir().expect("tempdir");
        let engine = test_engine();
        let _watcher = PolicyWatcher::new(Arc::clone(&engine), dir.path()).expect("watcher");

        std::fs::write(dir.path().join("p.wasm"), EMPTY_WASM).unwrap();
        wait_until("p registered", || engine._has_policy("p"));
        std::fs::write(dir.path().join("p.sig"), b"x").unwrap();
        std::fs::write(dir.path().join("p.txt"), b"x").unwrap();
        std::fs::write(dir.path().join("p.wasm.sig"), b"x").unwrap();
        std::fs::remove_file(dir.path().join("p.sig")).unwrap();
        std::fs::remove_file(dir.path().join("p.txt")).unwrap();
        std::fs::remove_file(dir.path().join("p.wasm.sig")).unwrap();
        // Positive control: events are handled in order, so once it is seen the removals were handled.
        std::fs::write(dir.path().join("control.wasm"), EMPTY_WASM).unwrap();
        wait_until("control registered", || engine._has_policy("control"));
        std::thread::sleep(std::time::Duration::from_millis(300));
        assert!(
            engine._has_policy("p"),
            "removing a non-policy file must not unregister p"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn deleting_or_breaking_a_signature_unloads_the_policy_unless_it_is_the_last() {
        let dir = tempfile::tempdir().expect("tempdir");
        let sk = ed25519_dalek::SigningKey::from_bytes(&[9u8; 32]);
        let engine = signed_engine(&sk);
        let _watcher = PolicyWatcher::new(Arc::clone(&engine), dir.path()).expect("watcher");
        let refusals = || {
            engine
                .kept_last_refusals
                .load(std::sync::atomic::Ordering::SeqCst)
        };

        for name in ["p", "q", "r"] {
            write_signed(dir.path(), &sk, name);
            wait_until("registered", || engine._has_policy(name));
        }

        // The signature is removed: p no longer verifies and is unloaded; the others stay.
        std::fs::remove_file(dir.path().join("p.wasm.sig")).unwrap();
        wait_until("p unloaded", || !engine._has_policy("p"));
        assert!(engine._has_policy("q") && engine._has_policy("r"));
        assert!(
            dir.path().join("p.wasm").exists(),
            "the policy file is not touched"
        );

        // The signature is changed to an invalid value: q is unloaded.
        std::fs::write(dir.path().join("q.wasm.sig"), "AAAA").unwrap();
        wait_until("q unloaded", || !engine._has_policy("q"));
        assert!(engine._has_policy("r"));

        // A .wasm.pqs event (no PQ key configured, so it changes nothing for r) keeps r loaded.
        std::fs::write(dir.path().join("r.wasm.pqs"), b"x").unwrap();
        // r is the last one: breaking its signature keeps it and says why.
        std::fs::remove_file(dir.path().join("r.wasm.sig")).unwrap();
        wait_until("removal for the last policy refused", || refusals() >= 1);
        assert!(engine._has_policy("r"));
        assert_eq!(engine.policy_count(), 1);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_broken_signature_only_logs_without_enforcement() {
        // A file named p.sig or p.wasm.pqs is ignored, and without enforcement a reload failure keeps the policy.
        let dir = tempfile::tempdir().expect("tempdir");
        let engine = test_engine();
        let _watcher = PolicyWatcher::new(Arc::clone(&engine), dir.path()).expect("watcher");
        std::fs::write(dir.path().join("p.wasm"), EMPTY_WASM).unwrap();
        wait_until("p registered", || engine._has_policy("p"));
        std::fs::write(dir.path().join("p.wasm.pqs"), b"x").unwrap();
        std::fs::write(dir.path().join("p.wasm.sig"), b"x").unwrap();
        std::fs::remove_file(dir.path().join("p.wasm.sig")).unwrap();
        std::fs::write(dir.path().join("control.wasm"), EMPTY_WASM).unwrap();
        wait_until("control registered", || engine._has_policy("control"));
        std::thread::sleep(std::time::Duration::from_millis(300));
        assert!(engine._has_policy("p"));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn renaming_a_wasm_file_away_unloads_it() {
        let dir = tempfile::tempdir().expect("tempdir");
        let engine = test_engine();
        let _watcher = PolicyWatcher::new(Arc::clone(&engine), dir.path()).expect("watcher");
        std::fs::write(dir.path().join("a.wasm"), EMPTY_WASM).unwrap();
        std::fs::write(dir.path().join("b.wasm"), EMPTY_WASM).unwrap();
        wait_until("both registered", || {
            engine._has_policy("a") && engine._has_policy("b")
        });
        std::fs::rename(dir.path().join("a.wasm"), dir.path().join("a.wasm.bak")).unwrap();
        wait_until("a unloaded", || !engine._has_policy("a"));
        assert!(engine._has_policy("b"));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn renaming_the_last_wasm_file_away_keeps_it_under_enforcement() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(dir.path().join("only.wasm"), EMPTY_WASM).unwrap();
        let engine = engine_allowing_only(EMPTY_WASM);
        engine.load_all_policies(dir.path()).expect("load");
        let _watcher = PolicyWatcher::new(Arc::clone(&engine), dir.path()).expect("watcher");
        std::fs::rename(
            dir.path().join("only.wasm"),
            dir.path().join("only.wasm.bak"),
        )
        .unwrap();
        wait_until("rename refused", || {
            engine
                .kept_last_refusals
                .load(std::sync::atomic::Ordering::SeqCst)
                >= 1
        });
        assert!(engine._has_policy("only"));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_directory_named_like_a_policy_is_ignored() {
        let dir = tempfile::tempdir().expect("tempdir");
        let engine = test_engine();
        let _watcher = PolicyWatcher::new(Arc::clone(&engine), dir.path()).expect("watcher");
        std::fs::create_dir(dir.path().join("x.wasm")).unwrap();
        std::fs::write(dir.path().join("control.wasm"), EMPTY_WASM).unwrap();
        wait_until("control registered", || engine._has_policy("control"));
        assert!(!engine._has_policy("x"));
        assert_eq!(engine.policy_count(), 1);
    }

    #[test]
    fn classify_uses_the_full_extension() {
        use std::path::Path;
        assert!(matches!(
            classify(Path::new("d/p.wasm")),
            PolicyFile::Policy
        ));
        assert!(matches!(
            classify(Path::new("d/p.wasm.sig")),
            PolicyFile::Signature(p) if p == Path::new("d/p.wasm")
        ));
        assert!(matches!(
            classify(Path::new("d/p.wasm.pqs")),
            PolicyFile::Signature(_)
        ));
        assert!(matches!(classify(Path::new("d/p.sig")), PolicyFile::Other));
        assert!(matches!(classify(Path::new("d/p.txt")), PolicyFile::Other));
        assert!(matches!(classify(Path::new("d/p")), PolicyFile::Other));
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
