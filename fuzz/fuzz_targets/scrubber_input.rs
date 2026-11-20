//! The scrubber reads every tool call and every log line, so its input is untrusted text.
//!
//! Invariants: no panic; the output is valid UTF-8 and is never much longer than the input; a fake secret
//! planted in the input (on its own line, so no neighbouring byte can legitimately hide it from the
//! pattern) never survives, as plain text or inside a JSON string; the JSON stays valid JSON. Time per
//! input is bounded by the libFuzzer -timeout of the CI job.
#![no_main]

use libfuzzer_sys::fuzz_target;
use zn::scrubber::Scrubber;

// Fake values only: the documentation AWS key id, a reserved example address, and a low-variety assignment.
const SECRETS: [&str; 3] = [
    "AKIAIOSFODNN7EXAMPLE",
    "user@example.com",
    "api_key=fakekeyfakekeyfakekey",
];
const NEEDLES: [&str; 3] = ["AKIAIOSFODNN7EXAMPLE", "user@example.com", "fakekeyfakekeyfakekey"];

fuzz_target!(|data: &[u8]| {
    let text = String::from_utf8_lossy(data);
    let text: &str = &text;

    // 1. Any text: no panic, bounded growth (each marker replaces a match of at least 6 bytes).
    let out = Scrubber::scrub(text);
    assert!(std::str::from_utf8(out.as_bytes()).is_ok());
    assert!(out.len() <= 3 * text.len() + 16, "{} bytes became {}", text.len(), out.len());
    let _ = Scrubber::redact_for_log(text);
    let _ = Scrubber::detect_pii_types(text);

    // 2. A planted secret never appears verbatim. The first input byte picks the secret and the split point.
    let pick = data.first().copied().unwrap_or(0) as usize;
    let secret = SECRETS[pick % SECRETS.len()];
    let needle = NEEDLES[pick % NEEDLES.len()];
    let mut cut = (pick * 7919) % (text.len() + 1);
    while !text.is_char_boundary(cut) {
        cut -= 1;
    }
    let (head, tail) = text.split_at(cut);
    let planted = format!("{head}\n{secret}\n{tail}");
    let scrubbed = Scrubber::scrub(&planted);
    assert!(!scrubbed.contains(needle), "planted secret survived");
    assert!(!Scrubber::redact_for_log(&planted).contains(needle), "planted secret survived the log view");

    // 3. The same inside a JSON string: the secret is masked and the document still parses.
    let json = serde_json::json!({ "cmd": planted }).to_string();
    let masked = Scrubber::scrub(&json);
    assert!(!masked.contains(needle), "planted secret survived inside JSON");
    assert!(serde_json::from_str::<serde_json::Value>(&masked).is_ok(), "scrub broke valid JSON");
});
