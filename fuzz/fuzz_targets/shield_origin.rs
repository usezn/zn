//! WebSocket origin check: arbitrary origins and allow-lists must never panic, an exact allow-list entry is
//! accepted and nothing else is, and with no allow-list only plain loopback origins pass.
#![no_main]

use libfuzzer_sys::fuzz_target;
use zn::shield::McpShield;

fuzz_target!(|data: &[u8]| {
    let Ok(text) = std::str::from_utf8(data) else {
        return;
    };
    // First line is the origin, the other lines are the allow-list.
    let mut lines = text.split('\n');
    let origin = lines.next().unwrap_or("");
    let allowed: Vec<String> = lines.map(str::to_string).collect();

    let accepted = McpShield::validate_origin(origin, &allowed);
    if allowed.is_empty() {
        if accepted {
            let lower = origin.to_ascii_lowercase();
            assert!(lower.starts_with("http://") || lower.starts_with("https://"));
            let rest = origin.split_once("://").map_or("", |(_, r)| r);
            assert!(!rest.contains('@'), "userinfo accepted: {origin:?}");
            assert!(!rest.contains('/') || rest.ends_with('/') && rest.matches('/').count() == 1);
            assert!(
                lower.contains("localhost")
                    || lower.contains("127.0.0.1")
                    || lower.contains("[::1]"),
                "non-loopback origin accepted: {origin:?}"
            );
        }
    } else {
        assert_eq!(accepted, allowed.iter().any(|o| o == origin));
    }
    // The first run must not depend on hidden state.
    assert_eq!(accepted, McpShield::validate_origin(origin, &allowed));
});
