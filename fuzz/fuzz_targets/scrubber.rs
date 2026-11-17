//! The scrubber reads every tool call and every log line, so its input is untrusted text.
#![no_main]

use libfuzzer_sys::fuzz_target;
use zn::scrubber::Scrubber;

fuzz_target!(|data: &[u8]| {
    let text = String::from_utf8_lossy(data);
    let text: &str = &text;

    let once = Scrubber::scrub(text);
    // The longest marker is 17 bytes for a match of at least 6 bytes (same bound as the property tests).
    assert!(
        once.len() <= 3 * text.len() + 16,
        "{} bytes became {} bytes",
        text.len(),
        once.len()
    );
    // A second pass finds nothing new.
    assert_eq!(Scrubber::scrub(&once), once, "second pass changed the text");

    // The log view (more shapes, then the same pass) must not panic on any input.
    let _ = Scrubber::redact_for_log(text);

    let types = Scrubber::detect_pii_types(text);
    // No type is reported twice.
    let mut seen = types.clone();
    seen.sort_unstable();
    seen.dedup();
    assert_eq!(seen.len(), types.len());

    let _ = Scrubber::contains_pii(text);
});
