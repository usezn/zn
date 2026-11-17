//! WebSocket Origin check: the Origin header is chosen by whatever web page the browser has open.
//!
//! Input: the origin on the first line, then the configured allowed origins, one per line.
#![no_main]

use libfuzzer_sys::fuzz_target;
use zn::shield::McpShield;

fuzz_target!(|data: &[u8]| {
    let text = String::from_utf8_lossy(data);
    let mut lines = text.split('\n');
    let origin = lines.next().unwrap_or("");
    let allowed: Vec<String> = lines.map(str::to_string).collect();

    let accepted = McpShield::validate_origin(origin, &allowed);

    if !allowed.is_empty() {
        // A configured list is an exact match, nothing looser.
        assert_eq!(accepted, allowed.iter().any(|o| o == origin));
        return;
    }
    if accepted {
        // Without a list only a loopback origin passes: scheme, loopback host, optional port, nothing else.
        let lower = origin.to_ascii_lowercase();
        let rest = lower
            .strip_prefix("http://")
            .or_else(|| lower.strip_prefix("https://"))
            .expect("an accepted origin starts with http:// or https://");
        let rest = rest.strip_suffix('/').unwrap_or(rest);
        assert!(!rest.contains('@') && !rest.contains('/') && !rest.contains('?') && !rest.contains('#'));
        assert!(
            rest == "localhost"
                || rest.starts_with("localhost:")
                || rest == "127.0.0.1"
                || rest.starts_with("127.0.0.1:")
                || rest == "[::1]"
                || rest.starts_with("[::1]:"),
            "accepted a non-loopback origin: {origin:?}"
        );
    }
});
