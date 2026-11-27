//! Tests for the error and unknown-value paths that decide allow or refuse in the gateway.
//! Every value is made up. Tests named `*_today_*` pin what the code does now where that is the
//! weaker outcome, so a fix has to change them on purpose.

use crate::config::{LoopBreakerConfig, ZnConfig};
use crate::engine::loop_breaker::LoopBreaker;
use crate::engine::{ZnEngine, ZnEngineConfig};
use crate::jsonrpc::{validate_jsonrpc, JsonRpcValidation};

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

fn quiet_config() -> ZnConfig {
    let mut cfg = ZnConfig::default();
    // The default reads ZN_DB_KEY; set what these tests rely on.
    cfg.audit.encryption_key = None;
    cfg.audit.encryption_enabled = false;
    cfg.audit.store_payloads = false;
    cfg.security.jwt_secret = None;
    cfg
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
fn a_file_that_is_not_wasm_without_enforcement_is_skipped_and_the_call_is_allowed() {
    // Deliberate: with nothing asking for signed policies, a gateway without policies is a valid setup.
    let dir = dir_with(&[("p.wasm", b"not a module")]);
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

// ---- config values (config/mod.rs validate, paranoia) ----

#[test]
fn an_unknown_kms_type_is_accepted_and_means_the_local_vault_today() {
    // main.rs matches only "aws"; every other spelling (AWS, gcp, vaults, a typo) is the local vault.
    for kind in ["AWS", "gcp", "vaults", "azur"] {
        let text =
            format!("{{\"kms\": {{\"kms_type\": \"{kind}\", \"key_id\": \"fake-key-id\"}}}}");
        let cfg = ZnConfig::parse_text("zn.json", &text).expect("parses");
        assert_eq!(cfg.kms.kms_type, kind);
        // validate() has no opinion about the type.
        let mut cfg = cfg;
        cfg.audit.encryption_key = None;
        cfg.security.jwt_secret = None;
        cfg.audit.store_payloads = false;
        assert!(cfg.validate().is_ok(), "{kind}");
    }
}

#[test]
fn environment_is_compared_exactly_so_another_spelling_skips_the_production_rules_today() {
    let mut cfg = quiet_config();
    cfg.environment = "production".to_string();
    assert!(cfg.validate().is_err(), "production needs the audit key");
    for spelling in ["Production", "PRODUCTION", "prod", "production "] {
        cfg.environment = spelling.to_string();
        assert!(cfg.validate().is_ok(), "{spelling:?}");
    }
}

#[test]
fn encryption_enabled_without_a_key_starts_unencrypted_outside_production_today() {
    let mut cfg = quiet_config();
    cfg.environment = "development".to_string();
    cfg.audit.encryption_enabled = true;
    cfg.audit.encryption_key = None;
    assert!(cfg.validate().is_ok());
}

#[test]
fn a_paranoia_level_out_of_range_in_the_file_means_balanced_today() {
    let mut cfg = quiet_config();
    cfg.guardrails.paranoia_level = 3;
    let balanced = (
        cfg.paranoia_threshold_multiplier(),
        cfg.paranoia_classifier_threshold(),
    );
    cfg.guardrails.paranoia_level = 5;
    let paranoid = (
        cfg.paranoia_threshold_multiplier(),
        cfg.paranoia_classifier_threshold(),
    );
    assert_ne!(balanced, paranoid);
    // The environment variable clamps to 1..=5; the file value is used as it is.
    for level in [0u8, 6, 9, 255] {
        cfg.guardrails.paranoia_level = level;
        let got = (
            cfg.paranoia_threshold_multiplier(),
            cfg.paranoia_classifier_threshold(),
        );
        assert_eq!(got, balanced, "level {level}");
    }
}

#[test]
fn a_neural_threshold_that_is_not_a_number_turns_the_anomaly_check_off_today() {
    // ZN_NEURAL_THRESHOLD is read with str::parse::<f32>, which accepts these words.
    for word in ["NaN", "nan", "inf", "infinity"] {
        let t: f32 = word.parse().expect("f32 parse accepts it");
        assert!(
            !crate::ai::neural_fired(1000.0, t, None, 0.5),
            "threshold {word}"
        );
    }
}

#[test]
fn a_fusion_tau_above_one_or_not_a_number_never_blocks_today() {
    use crate::engine::neural::fused_block;
    assert!(!fused_block(false, Some(0.99), 1.5));
    assert!(!fused_block(false, Some(1.0), f32::NAN));
    // A rule hit still blocks.
    assert!(fused_block(true, Some(0.0), 1.5));
}

// ---- loop breaker values ----

#[test]
fn a_loop_breaker_with_zero_repeats_refuses_the_first_call() {
    let lb = LoopBreaker::new(LoopBreakerConfig {
        enabled: true,
        max_repeats: 0,
        window_seconds: 60,
    });
    assert!(lb.check_and_record("ns:agent", "tool", "{}").is_err());
}

#[test]
fn a_loop_breaker_with_a_zero_window_never_refuses_today() {
    let lb = LoopBreaker::new(LoopBreakerConfig {
        enabled: true,
        max_repeats: 2,
        window_seconds: 0,
    });
    for _ in 0..10 {
        assert!(lb.check_and_record("ns:agent", "tool", "{}").is_ok());
        std::thread::sleep(std::time::Duration::from_millis(2));
    }
}

// ---- frames ----

#[test]
fn a_frame_nested_deeper_than_the_json_limit_is_an_error_not_a_pass_through() {
    let open = "[".repeat(300);
    let close = "]".repeat(300);
    let frame = format!(
        "{{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{{\"name\":\"t\",\"arguments\":{open}{close}}}}}"
    );
    assert!(matches!(
        validate_jsonrpc(&frame),
        JsonRpcValidation::Error { .. }
    ));
}

#[test]
fn a_frame_with_an_unknown_method_is_passed_through_by_design() {
    let frame = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"fake/unknown\",\"params\":{}}";
    assert!(matches!(
        validate_jsonrpc(frame),
        JsonRpcValidation::PassThrough
    ));
}

#[test]
fn a_frame_that_is_not_json_is_an_error() {
    for text in ["", "not json", "{", "[1]", "null", "\"x\"", "42"] {
        assert!(
            matches!(validate_jsonrpc(text), JsonRpcValidation::Error { .. }),
            "{text:?}"
        );
    }
}
