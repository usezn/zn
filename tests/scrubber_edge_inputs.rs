//! Scrubber edge inputs: a NUL-only input is handled without error, and a PostgreSQL URL password
//! is masked.
//!
//! The Rust scrubber works on strings, so "a file of NUL bytes" reaches it as a string of NUL
//! characters. Every value here is fake (`example.com` host, obviously fake password).

use zn::scrubber::Scrubber;

#[test]
fn nul_only_input_is_handled_without_error() {
    let big = "\0".repeat(64 * 1024);
    for input in ["\0", "\0\0\0\0", big.as_str()] {
        let out = Scrubber::scrub(input);
        assert_eq!(out, input, "NUL-only input must come back unchanged");
        assert!(!Scrubber::contains_pii(input));
    }
}

#[test]
fn postgres_url_password_is_masked() {
    let input = "DATABASE_URL=postgres://app:ZnTestFakePw42x@db.example.com:5432/app";
    let out = Scrubber::scrub(input);
    assert!(!out.contains("ZnTestFakePw42x"), "password leaked: {out}");
}

// The premise (password masked, host kept) does not hold yet: the email rule matches
// "ZnTestFakePw42x@db.example.com" as an address and replaces it, host included, with
// [EMAIL_REDACTED]. Node.js keeps the host (scrub_benign_properties.test.js). Product code is not
// changed here; this stays ignored until the Rust scrubber keeps the host.
#[test]
#[ignore = "Rust scrubber: the email rule swallows the host of a postgres URL (output: postgres://app:[EMAIL_REDACTED]:5432/app); Node.js keeps the host"]
fn postgres_url_keeps_its_host() {
    let input = "DATABASE_URL=postgres://app:ZnTestFakePw42x@db.example.com:5432/app";
    let out = Scrubber::scrub(input);
    assert!(out.contains("db.example.com:5432"), "host lost: {out}");
}
