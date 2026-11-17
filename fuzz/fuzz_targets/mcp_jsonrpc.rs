//! MCP and A2A frames: the validation that decides what a client message is, and the rewrite of its arguments.
#![no_main]

use libfuzzer_sys::fuzz_target;
use zn::jsonrpc::{
    has_duplicate_keys, nesting_exceeds, validate_jsonrpc, with_arguments, JsonRpcValidation,
    MAX_FRAME_DEPTH,
};

fuzz_target!(|data: &[u8]| {
    let Ok(frame) = std::str::from_utf8(data) else {
        return;
    };
    let verdict = validate_jsonrpc(frame);
    if !matches!(verdict, JsonRpcValidation::Error { .. }) {
        // A frame that is not refused was read to the end, repeats no key and is not nested too deep.
        assert!(!has_duplicate_keys(frame));
        assert!(!nesting_exceeds(frame, MAX_FRAME_DEPTH));
    }
    if let JsonRpcValidation::ToolCall {
        tool_name,
        arguments,
        source,
        ..
    } = verdict
    {
        assert!(!tool_name.is_empty());
        // The arguments handed to the policy check are always valid JSON text.
        assert!(serde_json::from_str::<serde_json::Value>(&arguments).is_ok());
        let _ = with_arguments(frame, &arguments, source);
        let _ = with_arguments(frame, "{\"redacted\":true}", source);
    }
});
