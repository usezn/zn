//! Scrubbing must be idempotent: one pass has to be enough. Found by the `scrubber` fuzz target (S2302-1).

use zn::scrubber::Scrubber;

/// Two phone numbers written back to back: the second one is only redacted by a second pass.
/// Ignored until B-1013 is fixed; remove the attribute then.
#[test]
#[ignore = "B-1013: the second of two back-to-back phone numbers survives the first pass"]
fn adjacent_phone_numbers_are_redacted_in_one_pass() {
    let once = Scrubber::scrub("+14155552671+14155552671");
    assert_eq!(once, "[PHONE_REDACTED][PHONE_REDACTED]");
    assert_eq!(Scrubber::scrub(&once), once);
}

/// Numbers that are separated were already stable; keep them that way.
#[test]
fn separated_phone_numbers_are_stable() {
    for input in ["+14155552671 +14155552671", "+14155552671,+14155552671"] {
        let once = Scrubber::scrub(input);
        assert_eq!(once, input.replace("+14155552671", "[PHONE_REDACTED]"));
        assert_eq!(Scrubber::scrub(&once), once);
    }
}
