//! MCP and A2A frames: the validation that decides what a client message is, and the rewrite of its arguments.
#![no_main]

use libfuzzer_sys::fuzz_target;
use zn::jsonrpc::{validate_jsonrpc, with_arguments, JsonRpcValidation};

fuzz_target!(|data: &[u8]| {
    let Ok(frame) = std::str::from_utf8(data) else {
        return;
    };
    if let JsonRpcValidation::ToolCall {
        tool_name,
        arguments,
        source,
        ..
    } = validate_jsonrpc(frame)
    {
        assert!(!tool_name.is_empty());
        // The arguments handed to the policy check are always valid JSON text.
        assert!(serde_json::from_str::<serde_json::Value>(&arguments).is_ok());
        let _ = with_arguments(frame, &arguments, source);
        let _ = with_arguments(frame, "{\"redacted\":true}", source);
    }
});
