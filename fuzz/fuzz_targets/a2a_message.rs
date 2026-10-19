//! Agent-to-agent messages: parameters and method names from a peer are untrusted text.
#![no_main]

use libfuzzer_sys::fuzz_target;
use serde_json::Value;
use zn::a2a::{is_a2a_method, resolve_policy_context, A2AParams};

fuzz_target!(|data: &[u8]| {
    let Ok(message) = serde_json::from_slice::<Value>(data) else {
        return;
    };
    let _ = serde_json::from_value::<A2AParams>(message.clone());
    let method = message.get("method").and_then(Value::as_str).unwrap_or("");
    let params = message.get("params").cloned().unwrap_or(Value::Null);
    let _ = is_a2a_method(method);
    let context = resolve_policy_context(method, &params);
    // The policy name is always an a2a route, whatever the peer sent.
    assert!(context.starts_with("a2a:"));
});
