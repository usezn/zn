//! Policy modules: a file in the policy folder is untrusted bytes until the engine has compiled it, and the
//! module then runs against every tool call, with host functions that read and write its memory.
//!
//! Input: the bytes of a module (binary or text format). A module that compiles is instantiated and called
//! with a tool name and arguments taken from the same bytes, under the same fuel and memory limits as in
//! the gateway.
#![no_main]

use libfuzzer_sys::fuzz_target;
use sha2::{Digest, Sha256};
use zn::engine::{ZnEngine, ZnEngineConfig};

/// The one module the pinned engine accepts: a policy that allows every call.
const PINNED: &[u8] = include_bytes!("../corpus/policy_wasm/allow-all");

fn config(allowed_hashes: Vec<String>) -> ZnEngineConfig {
    ZnEngineConfig {
        gas_limit: 1_000_000,
        memory_limit: 16 * 1024 * 1024,
        timeout_ms: 100,
        allowed_hashes,
        signing_public_key: None,
    }
}

thread_local! {
    static ENGINE: ZnEngine = ZnEngine::new(config(Vec::new())).expect("the engine starts");
    // An engine with an allow-list: only the pinned module may load.
    static PINNED_ENGINE: ZnEngine = ZnEngine::new(config(vec![hex::encode(Sha256::digest(PINNED))]))
        .expect("the engine starts");
}

fuzz_target!(|data: &[u8]| {
    ENGINE.with(|engine| {
        if let Ok(module) = engine._load_policy_from_bytes(data, "fuzz") {
            let name = String::from_utf8_lossy(&data[..data.len().min(16)]);
            let arguments = String::from_utf8_lossy(data);
            // A failure (a missing export, a trap, out of fuel) is an error value, never a crash.
            let _ = engine.check_tool_call(&module, &name, &arguments, Some("agent-example".into()));
            let _ = engine.check_tool_call(&module, "tool", "{}", None);
        }
    });

    // The allow-list: a module whose hash is not listed never loads, whatever it contains.
    PINNED_ENGINE.with(|engine| {
        let loaded = engine._load_policy_from_bytes(data, "fuzz").is_ok();
        if loaded {
            assert_eq!(Sha256::digest(data), Sha256::digest(PINNED));
        }
    });
});
