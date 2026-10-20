//! Policy modules: a file in the policy folder is untrusted bytes until the engine has compiled it.
#![no_main]

use libfuzzer_sys::fuzz_target;
use zn::engine::{ZnEngine, ZnEngineConfig};

thread_local! {
    static ENGINE: ZnEngine = ZnEngine::new(ZnEngineConfig {
        gas_limit: 1_000_000,
        memory_limit: 16 * 1024 * 1024,
        timeout_ms: 100,
        allowed_hashes: Vec::new(),
        signing_public_key: None,
    })
    .expect("the engine starts");
}

fuzz_target!(|data: &[u8]| {
    ENGINE.with(|engine| {
        let _ = engine._load_policy_from_bytes(data, "fuzz");
    });
});
