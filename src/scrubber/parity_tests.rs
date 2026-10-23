//! Tests of the PII types the Rust scrubber shares with the Node.js scrubber
//! (`packages/zn-gate/lib/scrub`): IBAN, DNI, NIE, IPv4 (off by default), and a name, an address
//! and a username next to an explicit key. Fictitious values only.
//!
//! These tests use the default options only, so they fail on a scrubber that lacks the types.

use super::Scrubber;

fn scrub(s: &str) -> String {
    Scrubber::scrub(s)
}

#[test]
fn iban_with_valid_checksum_is_redacted() {
    for (input, want) in [
        (
            "IBAN: GB82WEST12345698765432 please",
            "IBAN: [IBAN_REDACTED] please",
        ),
        ("GB82 WEST 1234 5698 7654 32", "[IBAN_REDACTED]"),
        ("DE89370400440532013000.", "[IBAN_REDACTED]."),
        ("ES9121000418450200051332,", "[IBAN_REDACTED],"),
        ("NL91 ABNA 0417 1643 00!", "[IBAN_REDACTED]!"),
    ] {
        assert_eq!(scrub(input), want, "{input}");
    }
}

#[test]
fn iban_negatives_are_left_alone() {
    for input in [
        "GB82WEST12345698765433",      // checksum fails
        "XX82WEST12345698765432",      // no such country
        "GB82WEST1234569876543",       // wrong length for GB
        "xGB82WEST12345698765432",     // part of a longer token
        "GB82WEST12345698765432X",     // part of a longer token
        "gb82west12345698765432",      // lower case is not matched
        "GB82-WEST-1234-5698-7654-32", // dashes are not group separators here
        "order GB82",
    ] {
        assert_eq!(scrub(input), input, "{input}");
    }
}

#[test]
fn dni_and_nie_need_the_check_letter() {
    assert_eq!(scrub("dni 12345678Z ok"), "dni [DNI_REDACTED] ok");
    assert_eq!(scrub("dni 12345678-Z."), "dni [DNI_REDACTED].");
    assert_eq!(scrub("nie X1234567L ok"), "nie [NIE_REDACTED] ok");
    assert_eq!(scrub("nie Y-1234567-X ok"), "nie [NIE_REDACTED] ok");
    for input in [
        "12345678A",    // wrong letter
        "_12345678Z",   // part of a longer token
        "12345678Z_",   // part of a longer token
        "v1.12345678Z", // after a dot
        "123456789Z",   // nine digits
        "X1234567A",    // wrong letter
        "A1234567L",    // not an NIE prefix
        "12345678z",    // lower case
    ] {
        assert_eq!(scrub(input), input, "{input}");
    }
}

#[test]
fn ipv4_is_off_by_default() {
    for input in ["host 8.8.8.8 up", "45.33.32.156", "1.2.3.4"] {
        assert_eq!(scrub(input), input, "{input}");
        assert!(!Scrubber::contains_pii(input), "{input}");
    }
}

#[test]
fn name_after_a_key_is_redacted() {
    for (input, want) in [
        (
            "X-User-Name: Jane Example",
            "X-User-Name: [PERSON_NAME_REDACTED]",
        ),
        (
            "/submit?name=Jane+Example&x=1",
            "/submit?name=[PERSON_NAME_REDACTED]&x=1",
        ),
        (
            "curl -H 'X-User-Name: Jane Example' https://example.com/",
            "curl -H 'X-User-Name: [PERSON_NAME_REDACTED]' https://example.com/",
        ),
        (
            r#"{"X-Full-Name":"Jane Example"}"#,
            r#"{"X-Full-Name":"[PERSON_NAME_REDACTED]"}"#,
        ),
        (
            "full_name=María José García",
            "full_name=[PERSON_NAME_REDACTED]",
        ),
    ] {
        assert_eq!(scrub(input), want, "{input}");
    }
}

#[test]
fn name_negatives_are_left_alone() {
    for input in [
        "Her name is Jane Example.", // no key
        "name=build tools",          // generic key: words must be capitalised
        "name=root",                 // generic key, one word
        "X-User-Name: {{name}}",     // template
        "X-User-Name: null",         // null-like
        "X-User-Name: a b c d e f",  // more than five words
        "X-User-Name: 12345",        // not letters
        "NAME=Jane Example",         // ALL-CAPS environment variable
        "filename=Jane Example",     // key is part of a longer word
    ] {
        assert_eq!(scrub(input), input, "{input}");
    }
}

#[test]
fn address_after_a_key_is_redacted() {
    assert_eq!(
        scrub("X-Address: 1 Example Street"),
        "X-Address: [POSTAL_ADDRESS_REDACTED]"
    );
    assert_eq!(
        scrub("/ship?address=1+Example+Street&zip=1"),
        "/ship?address=[POSTAL_ADDRESS_REDACTED]&zip=1"
    );
    assert_eq!(
        scrub("address=12 Rue de la Paix, Paris"),
        "address=[POSTAL_ADDRESS_REDACTED]"
    );
    for input in [
        "Ship to 1 Example Street, Springfield", // no key
        "X-Address: Example Street",             // no number
        "X-Address: 1234",                       // one token
        "address=https://example.com/a b",       // a URL
        "address=0x12 abcd",                     // a hex value
    ] {
        assert_eq!(scrub(input), input, "{input}");
    }
}

#[test]
fn username_after_a_key_is_redacted() {
    assert_eq!(
        scrub("X-Username: jane_example"),
        "X-Username: [USERNAME_REDACTED]"
    );
    assert_eq!(
        scrub("/login?username=jane_example&x=1"),
        "/login?username=[USERNAME_REDACTED]&x=1"
    );
    assert_eq!(
        scrub("X-Forwarded-User: jane.example"),
        "X-Forwarded-User: [USERNAME_REDACTED]"
    );
    for input in [
        "user jane_example logged in",                      // no key
        "X-Username: root",                                 // a system account
        "X-Username: 12345",                                // digits only
        "X-Username: j",                                    // too short
        "X-Username: 123e4567-e89b-12d3-a456-426614174000", // UUID
        "USER=jane_example",                                // environment variable
    ] {
        assert_eq!(scrub(input), input, "{input}");
    }
}

#[test]
fn overlapping_spans_are_redacted_once() {
    // The username value also holds a DNI plus a dot: one span, the longer one names it.
    assert_eq!(
        scrub("X-Username: 12345678Z."),
        "X-Username: [USERNAME_REDACTED]"
    );
    // A DNI in a plain sentence is a DNI.
    assert_eq!(scrub("id 12345678Z."), "id [DNI_REDACTED].");
}

#[test]
fn new_types_never_panic_and_are_stable() {
    let inputs = [
        "X-User-Name: é日本",
        "X-Address: 日本 1 日本",
        "name=Jane+Example%zz",
        "name=%E4%BD%A0%E5%A5%BD",
        "X-User-Name:\u{2028}Jane Example",
        "x-user-name: \u{a0}Jane Example\u{a0}",
        "X-Username\": \"jane_example\\\"",
        "GB82WEST12345698765432GB82WEST12345698765432",
        "12345678Z12345678Z",
        "X-User: ",
        "name=",
        "address=&address=1 Example Street&",
    ];
    for input in inputs {
        let once = scrub(input);
        assert_eq!(scrub(&once), once, "not stable: {input:?} -> {once:?}");
    }
    for input in [
        "X-User-Name: Jane Example",
        "name=Jane+Example&user=jane_example&address=1+Example+Street",
        "GB82WEST12345698765432 12345678Z X1234567L",
    ] {
        let once = scrub(input);
        assert_eq!(scrub(&once), once, "not stable: {input:?} -> {once:?}");
    }
}

#[test]
fn long_adversarial_inputs_finish() {
    // Repeated near-matches: every group start is a candidate. Linear-time smoke test.
    let n = 20_000;
    let texts = [
        "AB12 CDEF GHIJ KLMN OPQR STUV WXYZ 1234 5678X ".repeat(n / 40),
        "1.2.3.4567 ".repeat(n / 10),
        "X-Username:".repeat(n / 10),
        "name=Jane Example\n".repeat(n / 15),
        "12345678-".repeat(n / 8),
    ];
    for t in &texts {
        let _ = scrub(t);
    }
}
