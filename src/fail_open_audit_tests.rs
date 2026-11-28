//! Tests for the policy-loading paths that decide allow or refuse in the gateway when a signing key
//! or allowed policy hashes are configured. Every value is made up.

use crate::engine::{ZnEngine, ZnEngineConfig};

/// A WASM module with no sections: it compiles, but exports no memory or functions.
const EMPTY_MODULE: &[u8] = b"\0asm\x01\0\0\0";
/// 32 bytes of hex that are not a real key (zeros).
const FAKE_HASH_HEX: &str = "0000000000000000000000000000000000000000000000000000000000000000";

fn engine(allowed_hashes: Vec<String>, signing_public_key: Option<String>) -> ZnEngine {
    ZnEngine::new(ZnEngineConfig {
        gas_limit: 1_000_000,
        memory_limit: 10 * 1024 * 1024,
        timeout_ms: 200,
        allowed_hashes,
        signing_public_key,
    })
    .expect("engine")
}

fn dir_with(files: &[(&str, &[u8])]) -> tempfile::TempDir {
    let dir = tempfile::tempdir().expect("temp dir");
    for (name, bytes) in files {
        std::fs::write(dir.path().join(name), bytes).expect("write");
    }
    dir
}

// ---- policy load (engine/mod.rs load_all_policies, check_tool_call_all) ----

fn load_error(e: &ZnEngine, dir: &tempfile::TempDir) -> String {
    format!(
        "{}",
        e.load_all_policies(dir.path()).expect_err("load must fail")
    )
}

fn empty_module_hash() -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(EMPTY_MODULE))
}

#[test]
fn policy_that_fails_the_hash_list_stops_startup_and_is_named() {
    let dir = dir_with(&[("p.wasm", EMPTY_MODULE)]);
    let e = engine(vec![FAKE_HASH_HEX.to_string()], None);
    let msg = load_error(&e, &dir);
    assert!(msg.contains("p.wasm"), "{msg}");
    assert_eq!(e.policy_count(), 0);
}

#[test]
fn a_blank_hash_list_entry_means_not_set() {
    // ZN_POLICY_HASHES="" (an unset compose variable) is an empty list, not [""] that matches nothing.
    let dir = dir_with(&[("p.wasm", EMPTY_MODULE)]);
    let e = engine(vec![String::new(), "  ".to_string()], None);
    assert!(!e.policy_enforcement_configured());
    e.load_all_policies(dir.path()).expect("load returns Ok");
    assert_eq!(e.policy_count(), 1);
}

#[test]
fn policy_without_its_signature_file_stops_startup_and_is_named() {
    let dir = dir_with(&[("p.wasm", EMPTY_MODULE)]);
    let e = engine(vec![], Some(FAKE_HASH_HEX.to_string()));
    let msg = load_error(&e, &dir);
    assert!(msg.contains("p.wasm"), "{msg}");
    assert_eq!(e.policy_count(), 0);
}

#[test]
fn one_bad_policy_among_good_ones_stops_startup_when_enforcement_is_configured() {
    let dir = dir_with(&[("p.wasm", EMPTY_MODULE), ("bad.wasm", b"not a module")]);
    // A hash list that allows the good file only.
    let e = engine(vec![empty_module_hash()], None);
    let msg = load_error(&e, &dir);
    assert!(msg.contains("bad.wasm"), "{msg}");
    assert!(!msg.contains("p.wasm"), "{msg}");
}

#[test]
fn enforcement_configured_and_no_policy_in_the_folder_is_an_error() {
    let dir = dir_with(&[]);
    let e = engine(vec![FAKE_HASH_HEX.to_string()], None);
    let msg = load_error(&e, &dir);
    assert!(msg.contains("no policy was loaded"), "{msg}");
}

#[test]
fn policy_files_of_which_none_loaded_stop_startup_without_enforcement() {
    // Files that were put there to be checked, none of which loads: an error naming the file, not a
    // gateway that allows everything.
    let dir = dir_with(&[("p.wasm", b"not a module")]);
    let e = engine(vec![], None);
    let msg = load_error(&e, &dir);
    assert!(msg.contains("p.wasm"), "{msg}");
    assert!(msg.contains("none of them loaded"), "{msg}");
    assert_eq!(e.policy_count(), 0);
}

#[test]
fn a_bad_file_among_loaded_ones_is_only_logged_without_enforcement() {
    let dir = dir_with(&[("p.wasm", EMPTY_MODULE), ("bad.wasm", b"not a module")]);
    let e = engine(vec![], None);
    e.load_all_policies(dir.path()).expect("one policy loaded");
    assert_eq!(e.policy_count(), 1);
}

#[test]
fn a_folder_without_policy_files_and_without_enforcement_is_a_valid_setup_that_allows() {
    // Deliberate: with nothing asking for policies and no policy file, a gateway without policies is valid.
    let dir = dir_with(&[("notes.txt", b"not a policy")]);
    let e = engine(vec![], None);
    e.load_all_policies(dir.path()).expect("load returns Ok");
    assert_eq!(e.policy_count(), 0);
    assert!(e.check_tool_call_all("any_tool", "{}", None).unwrap());
}

#[test]
fn an_empty_policy_set_with_enforcement_configured_is_an_error_not_an_allow() {
    for e in [
        engine(vec![FAKE_HASH_HEX.to_string()], None),
        engine(vec![], Some(FAKE_HASH_HEX.to_string())),
    ] {
        assert_eq!(e.policy_count(), 0);
        assert!(e.check_tool_call_all("any_tool", "{}", None).is_err());
    }
}

#[test]
fn the_last_policy_is_kept_when_enforcement_is_configured_and_removed_otherwise() {
    let dir = dir_with(&[("p.wasm", EMPTY_MODULE)]);
    let open = engine(vec![], None);
    open.load_all_policies(dir.path()).expect("load");
    assert!(open.unregister_policy_unless_last("p"));
    assert_eq!(open.policy_count(), 0);

    let enforced = engine(vec![empty_module_hash()], None);
    enforced.load_all_policies(dir.path()).expect("load");
    assert!(!enforced.unregister_policy_unless_last("p"));
    assert_eq!(enforced.policy_count(), 1);
}

#[test]
fn a_loaded_policy_that_cannot_run_denies_and_removing_it_allows_without_enforcement() {
    let dir = dir_with(&[("p.wasm", EMPTY_MODULE)]);
    let e = engine(vec![], None);
    e.load_all_policies(dir.path()).expect("load");
    assert_eq!(e.policy_count(), 1);
    // The module has no memory export: the check errors, which the gateway turns into DENIED.
    assert!(e.check_tool_call_all("any_tool", "{}", None).is_err());
    e.unregister_policy("p");
    assert!(e.check_tool_call_all("any_tool", "{}", None).unwrap());
}

#[test]
fn an_invalid_signing_key_stops_the_engine_from_starting() {
    for bad in ["", "zz", "abcd", "not hex at all"] {
        let r = ZnEngine::new(ZnEngineConfig {
            gas_limit: 1,
            memory_limit: 1024,
            timeout_ms: 100,
            allowed_hashes: vec![],
            signing_public_key: Some(bad.to_string()),
        });
        assert!(r.is_err(), "signing key {bad:?} must be an error");
    }
}

// ---- removals are serialized (delete endpoint and folder watcher) ----

fn enforced_engine_with_two_policies() -> (std::sync::Arc<ZnEngine>, tempfile::TempDir) {
    let dir = dir_with(&[("p.wasm", EMPTY_MODULE), ("q.wasm", EMPTY_MODULE)]);
    let e = engine(vec![empty_module_hash()], None);
    e.load_all_policies(dir.path()).expect("load");
    assert_eq!(e.policy_count(), 2);
    (std::sync::Arc::new(e), dir)
}

#[test]
fn two_concurrent_deletes_leave_one_policy_and_its_file() {
    for _ in 0..50 {
        let (e, dir) = enforced_engine_with_two_policies();
        let barrier = std::sync::Barrier::new(2);
        let results: Vec<Option<bool>> = std::thread::scope(|s| {
            let handles: Vec<_> = ["p", "q"]
                .into_iter()
                .map(|name| {
                    let (e, barrier, path) = (&e, &barrier, dir.path());
                    s.spawn(move || {
                        barrier.wait();
                        e.delete_policy_guarded(path, name).expect("no io error")
                    })
                })
                .collect();
            handles.into_iter().map(|h| h.join().unwrap()).collect()
        });
        assert_eq!(
            results.iter().filter(|r| r.is_some()).count(),
            1,
            "{results:?}"
        );
        assert_eq!(
            results.iter().filter(|r| r.is_none()).count(),
            1,
            "{results:?}"
        );
        assert_eq!(e.policy_count(), 1);
        let files = ["p.wasm", "q.wasm"]
            .iter()
            .filter(|f| dir.path().join(f).exists())
            .count();
        assert_eq!(files, 1, "the refused policy keeps its file");
        let left = e.list_policies().pop().unwrap();
        assert!(dir.path().join(format!("{left}.wasm")).exists());
    }
}

#[test]
fn deleting_the_same_policy_twice_concurrently_succeeds_and_keeps_the_other() {
    let (e, dir) = enforced_engine_with_two_policies();
    let barrier = std::sync::Barrier::new(2);
    std::thread::scope(|s| {
        for _ in 0..2 {
            let (e, barrier, path) = (&e, &barrier, dir.path());
            s.spawn(move || {
                barrier.wait();
                assert!(e.delete_policy_guarded(path, "p").expect("ok").is_some());
            });
        }
    });
    assert_eq!(e.list_policies(), vec!["q".to_string()]);
    assert!(dir.path().join("q.wasm").exists());
}

#[test]
fn a_watcher_removal_racing_a_delete_cannot_leave_zero_policies() {
    for _ in 0..50 {
        let (e, dir) = enforced_engine_with_two_policies();
        let barrier = std::sync::Barrier::new(2);
        std::thread::scope(|s| {
            let (e1, b1, path) = (&e, &barrier, dir.path());
            s.spawn(move || {
                b1.wait();
                let _ = e1.delete_policy_guarded(path, "p").expect("no io error");
            });
            let (e2, b2) = (&e, &barrier);
            s.spawn(move || {
                b2.wait();
                // What the folder watcher does when a .wasm file disappears.
                e2.unregister_policy_unless_last("q");
            });
        });
        assert_eq!(e.policy_count(), 1);
    }
}

#[test]
fn a_refused_delete_does_not_touch_the_file_and_an_open_engine_may_delete_the_last_policy() {
    let dir = dir_with(&[("p.wasm", EMPTY_MODULE)]);
    let enforced = engine(vec![empty_module_hash()], None);
    enforced.load_all_policies(dir.path()).expect("load");
    assert_eq!(
        enforced.delete_policy_guarded(dir.path(), "p").unwrap(),
        None
    );
    assert!(dir.path().join("p.wasm").exists());
    assert_eq!(enforced.policy_count(), 1);

    let open = engine(vec![], None);
    open.load_all_policies(dir.path()).expect("load");
    assert_eq!(
        open.delete_policy_guarded(dir.path(), "p").unwrap(),
        Some(true)
    );
    assert!(!dir.path().join("p.wasm").exists());
    assert_eq!(open.policy_count(), 0);
}
