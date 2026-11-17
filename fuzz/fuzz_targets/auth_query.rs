//! Where a credential comes from: the query string, percent-escapes and the `Bearer` prefix are untrusted text.
//!
//! Input: two strings split at the first NUL byte (the second one may be empty).
#![no_main]

use libfuzzer_sys::fuzz_target;
use zn::auth::{constant_time_compare, fuzz_entry, mcp_ws_token_matches};

fuzz_target!(|data: &[u8]| {
    let text = String::from_utf8_lossy(data);
    let (a, b) = text.split_once('\0').unwrap_or((&text, ""));

    // Percent-decoding: escaping every byte of a string and decoding it gives the string back.
    let escaped: String = a.bytes().map(|byte| format!("%{byte:02X}")).collect();
    assert_eq!(fuzz_entry::percent_decode(&escaped).as_deref(), Some(a));
    // Arbitrary input never panics; without a '%' the text is returned as it is.
    let decoded = fuzz_entry::percent_decode(a);
    if !a.contains('%') {
        assert_eq!(decoded.as_deref(), Some(a));
    }

    // A token only comes out of a parameter that is named for it.
    if fuzz_entry::query_token(a).is_some() {
        assert!(a.contains("api_key=") || a.contains("token="));
    }
    let _ = fuzz_entry::query_token_allowed(a);

    // The prefix and the spaces are removed, nothing else is added.
    let stripped = fuzz_entry::strip_bearer(a);
    assert_eq!(stripped, stripped.trim());
    assert!(stripped.len() <= a.len());

    // The comparison agrees with equality.
    assert_eq!(constant_time_compare(a, b), a == b);

    // The WebSocket token check: no token configured lets everything in; a match needs an exact, non-blank token.
    assert!(mcp_ws_token_matches(None, Some(b)));
    if mcp_ws_token_matches(Some(a), Some(b)) {
        assert_eq!(a, b);
        assert!(!a.trim().is_empty());
    }
});
