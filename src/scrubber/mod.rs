//! PII Scrubber Module
//!
//! Provides real-time scrubbing of Personally Identifiable Information (PII)
//! and sensitive data from JSON-RPC streams before logging and processing.
//!
//! ## Supported Patterns
//! - Email addresses → `[EMAIL_REDACTED]`
//! - API keys, secrets, passwords, tokens → `[SECRET_REDACTED]`
//! - Credit card numbers (known network prefix and length, Luhn checksum) → `[CARD_REDACTED]`
//! - Social Security Numbers (US, valid area/group/serial) → `[SSN_REDACTED]`
//! - Phone numbers (E.164 `+<digits>`, or formatted NANP numbers) → `[PHONE_REDACTED]`
//! - AWS access key ids (`AKIA`, `ASIA`, `ABIA`, `ACCA`) → `[AWS_KEY_REDACTED]`
//! - AWS secret access keys, when named (`aws_secret_access_key = ...`) → `[AWS_SECRET_REDACTED]`
//! - Google API keys (`AIza...`) → `[GOOGLE_API_KEY_REDACTED]`
//! - PEM private keys (service-account `private_key` fields included) → `[PRIVATE_KEY_REDACTED]`
//! - Azure storage `AccountKey=...==` → `[AZURE_STORAGE_KEY_REDACTED]`
//!
//! Card, SSN and phone candidates must stand on their own (not be part of a
//! longer number or word) and pass the same checks as the Node.js scrubber,
//! so IDs, timestamps and other long digit runs are left alone.
//!
//! ## Performance
//! Regex patterns are compiled once and cached using `OnceLock` for optimal performance.

use regex::Regex;
use std::sync::OnceLock;

/// PII Scrubber for sanitizing sensitive data
pub struct Scrubber;

// Compiled regex patterns (initialized once)
static EMAIL_REGEX: OnceLock<Regex> = OnceLock::new();
static API_KEY_REGEX: OnceLock<Regex> = OnceLock::new();
static CREDIT_CARD_REGEX: OnceLock<Regex> = OnceLock::new();
static SSN_REGEX: OnceLock<Regex> = OnceLock::new();
static E164_REGEX: OnceLock<Regex> = OnceLock::new();
static NANP_REGEX: OnceLock<Regex> = OnceLock::new();
static JWT_REGEX: OnceLock<Regex> = OnceLock::new();
static AWS_KEY_REGEX: OnceLock<Regex> = OnceLock::new();
static AWS_SECRET_REGEX: OnceLock<Regex> = OnceLock::new();
static GOOGLE_KEY_REGEX: OnceLock<Regex> = OnceLock::new();
static PEM_REGEX: OnceLock<Regex> = OnceLock::new();
static PEM_TRUNCATED_REGEX: OnceLock<Regex> = OnceLock::new();
static AZURE_KEY_REGEX: OnceLock<Regex> = OnceLock::new();

fn email_re() -> &'static Regex {
    EMAIL_REGEX
        .get_or_init(|| Regex::new(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}").unwrap())
}

fn api_re() -> &'static Regex {
    API_KEY_REGEX.get_or_init(|| {
        // Matches: api_key=xxx, secret: xxx, password=xxx, token: xxx
        // Requires at least 8 characters for the value (reduced from 16 for better detection)
        Regex::new(r#"(?i)(api[_-]?key|secret[_-]?key|password|token|auth[_-]?token|access[_-]?token|bearer)[ ]*[:=][ ]*['"]?([a-zA-Z0-9_\-.]{8,})['"]?"#).unwrap()
    })
}

fn card_re() -> &'static Regex {
    // 13-19 digits in groups of four, optionally separated by spaces or dashes.
    // ASCII digits only ([0-9]): `\d` in the regex crate also matches other scripts' digits.
    CREDIT_CARD_REGEX.get_or_init(|| {
        Regex::new(r"(?:[0-9]{4}[ -]?){2,3}[0-9]{1,4}(?:[ -]?[0-9]{1,3})?").unwrap()
    })
}

fn ssn_re() -> &'static Regex {
    // US Social Security Numbers (XXX-XX-XXXX)
    SSN_REGEX.get_or_init(|| Regex::new(r"[0-9]{3}-[0-9]{2}-[0-9]{4}").unwrap())
}

fn e164_re() -> &'static Regex {
    E164_REGEX.get_or_init(|| Regex::new(r"\+[1-9][0-9]{7,14}").unwrap())
}

fn nanp_re() -> &'static Regex {
    // (415) 555-2671, 415-555-2671, 415.555.2671, +1 415 555 2671.
    // A bare run of ten digits is not a phone number here: it is far more
    // often an ID or a timestamp.
    NANP_REGEX.get_or_init(|| {
        Regex::new(r"(?:\+?1[-. ])?(?:\([0-9]{3}\) ?|[0-9]{3}[-. ])[0-9]{3}[-. ][0-9]{4}").unwrap()
    })
}

fn jwt_re() -> &'static Regex {
    // Matches JWT tokens (header.payload.signature format)
    JWT_REGEX.get_or_init(|| {
        Regex::new(r"eyJ[a-zA-Z0-9_-]*\.eyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*").unwrap()
    })
}

// Cloud credentials. Same shapes and labels as the Node.js scrubber. The regex
// crate has no lookaround, so the "not part of a longer token" checks are
// captured boundary groups that are put back in the replacement.

fn aws_key_re() -> &'static Regex {
    AWS_KEY_REGEX.get_or_init(|| {
        Regex::new(r"(^|[^A-Za-z0-9])((?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16})($|[^A-Za-z0-9])")
            .unwrap()
    })
}

fn aws_secret_re() -> &'static Regex {
    AWS_SECRET_REGEX.get_or_init(|| {
        // Only when the secret key is named: 40 base64 characters alone are too common.
        Regex::new(
            r#"(?i)((?:aws[_-]?)?secret[_ -]?access[_ -]?key["']?[ \t]*[:=][ \t]*["']?)([A-Za-z0-9+/]{40})($|[^A-Za-z0-9+/])"#,
        )
        .unwrap()
    })
}

fn google_key_re() -> &'static Regex {
    GOOGLE_KEY_REGEX.get_or_init(|| {
        Regex::new(r"(^|[^A-Za-z0-9_-])(AIza[0-9A-Za-z_-]{35})($|[^A-Za-z0-9_-])").unwrap()
    })
}

fn pem_re() -> &'static Regex {
    // Whole block. The body may hold real or JSON-escaped line breaks.
    PEM_REGEX.get_or_init(|| {
        Regex::new(r"-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----[A-Za-z0-9+/=\s\\]*?-----END (?:[A-Z]+ )*PRIVATE KEY-----")
            .unwrap()
    })
}

fn pem_truncated_re() -> &'static Regex {
    // A block cut off before its END line (a truncated tool output).
    PEM_TRUNCATED_REGEX.get_or_init(|| {
        Regex::new(r"-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----(?:\r?\n|\\n)[A-Za-z0-9+/=\s\\]{20,}")
            .unwrap()
    })
}

fn azure_key_re() -> &'static Regex {
    AZURE_KEY_REGEX.get_or_init(|| Regex::new(r"AccountKey=[A-Za-z0-9+/]{86}==").unwrap())
}

/// An id made of one repeated character after its prefix is a placeholder.
fn aws_key_is_real(key: &str) -> bool {
    let b = key.as_bytes();
    !b[4..].iter().all(|&c| c == b[4])
}

fn scrub_aws_keys(text: &str) -> String {
    aws_key_re()
        .replace_all(text, |c: &regex::Captures| {
            if aws_key_is_real(&c[2]) {
                format!("{}[AWS_KEY_REDACTED]{}", &c[1], &c[3])
            } else {
                c[0].to_string()
            }
        })
        .into_owned()
}

fn scrub_cloud_keys(text: &str) -> String {
    let mut out = pem_re()
        .replace_all(text, "[PRIVATE_KEY_REDACTED]")
        .into_owned();
    out = pem_truncated_re()
        .replace_all(&out, "[PRIVATE_KEY_REDACTED]")
        .into_owned();
    out = scrub_aws_keys(&out);
    out = aws_secret_re()
        .replace_all(&out, "${1}[AWS_SECRET_REDACTED]${3}")
        .into_owned();
    out = google_key_re()
        .replace_all(&out, "${1}[GOOGLE_API_KEY_REDACTED]${3}")
        .into_owned();
    azure_key_re()
        .replace_all(&out, "AccountKey=[AZURE_STORAGE_KEY_REDACTED]")
        .into_owned()
}

/* ------------------------------------------------------------------ */
/* Checksums and validators (same rules as the Node.js scrubber)       */
/* ------------------------------------------------------------------ */

fn luhn_valid(digits: &str) -> bool {
    let mut sum = 0u32;
    let mut dbl = false;
    for c in digits.chars().rev() {
        let Some(mut d) = c.to_digit(10) else {
            return false;
        };
        if dbl {
            d *= 2;
            if d > 9 {
                d -= 9;
            }
        }
        sum += d;
        dbl = !dbl;
    }
    sum.is_multiple_of(10)
}

fn all_same(digits: &str) -> bool {
    let b = digits.as_bytes();
    b.len() > 1 && b.iter().all(|&c| c == b[0])
}

/// Card networks by IIN prefix and allowed lengths.
fn card_network_ok(d: &str) -> bool {
    let len = d.len();
    let prefix = |n: usize| d[..n].parse::<u32>().unwrap_or(0);
    let (p2, p3, p4, p6) = (prefix(2), prefix(3), prefix(4), prefix(6));
    if d.starts_with('4') {
        return len == 13 || len == 16 || len == 19; // Visa
    }
    if (51..=55).contains(&p2) || (222100..=272099).contains(&p6) {
        return len == 16; // Mastercard
    }
    if p2 == 34 || p2 == 37 {
        return len == 15; // Amex
    }
    if p4 == 6011 || p2 == 65 || (644..=649).contains(&p3) {
        return (16..=19).contains(&len); // Discover
    }
    if (3528..=3589).contains(&p4) {
        return (16..=19).contains(&len); // JCB
    }
    if p2 == 36 || p2 == 38 || p2 == 39 || (300..=305).contains(&p3) {
        return (14..=19).contains(&len); // Diners
    }
    if p2 == 62 {
        return (16..=19).contains(&len); // UnionPay
    }
    false
}

fn card_valid(raw: &str) -> bool {
    // One kind of separator only: "4111 1111-1111 1111" is not a card number.
    let has_space = raw.contains(' ');
    let has_dash = raw.contains('-');
    if has_space && has_dash {
        return false;
    }
    let d: String = raw.chars().filter(|c| c.is_ascii_digit()).collect();
    if !(13..=19).contains(&d.len()) || all_same(&d) {
        return false;
    }
    card_network_ok(&d) && luhn_valid(&d)
}

/// US SSN: area 001-899 except 666, group 01-99, serial 0001-9999.
fn ssn_valid(raw: &str) -> bool {
    let parts: Vec<&str> = raw.split('-').collect();
    if parts.len() != 3 {
        return false;
    }
    let area: u32 = parts[0].parse().unwrap_or(0);
    if area == 0 || area == 666 || area >= 900 {
        return false;
    }
    parts[1] != "00" && parts[2] != "0000"
}

fn sequential(digits: &str) -> bool {
    ["0123456789", "1234567890", "9876543210"]
        .iter()
        .any(|s| digits.contains(s))
}

/// NANP national number: area and exchange codes start with 2-9.
fn nanp_national_valid(nat: &str) -> bool {
    let b = nat.as_bytes();
    nat.len() == 10
        && nat.bytes().all(|c| c.is_ascii_digit())
        && (b'2'..=b'9').contains(&b[0])
        && (b'2'..=b'9').contains(&b[3])
}

/// E.164: + then 8..15 digits. NANP (+1) must be exactly 10 national digits
/// with valid area and exchange codes; a few large plans get their national
/// lengths checked.
fn e164_valid(raw: &str) -> bool {
    let Some(digits) = raw.strip_prefix('+') else {
        return false;
    };
    if !(8..=15).contains(&digits.len()) || !digits.bytes().all(|c| c.is_ascii_digit()) {
        return false;
    }
    if all_same(digits) || sequential(digits) || digits.starts_with('0') {
        return false;
    }
    if let Some(nat) = digits.strip_prefix('1') {
        return nanp_national_valid(nat);
    }
    const LENGTHS: &[(&str, &[usize])] = &[
        ("351", &[9]),
        ("44", &[10]),
        ("34", &[9]),
        ("33", &[9]),
        ("49", &[7, 8, 9, 10, 11]),
        ("39", &[9, 10]),
        ("31", &[9]),
        ("32", &[8, 9]),
        ("41", &[9]),
        ("43", &[7, 8, 9, 10, 11, 12, 13]),
        ("52", &[10]),
        ("55", &[10, 11]),
        ("61", &[9]),
        ("81", &[9, 10]),
        ("91", &[10]),
    ];
    for cc_len in [3, 2] {
        let cc = &digits[..cc_len];
        if let Some((_, lens)) = LENGTHS.iter().find(|(c, _)| *c == cc) {
            return lens.contains(&(digits.len() - cc_len));
        }
    }
    (10..=15).contains(&digits.len())
}

fn formatted_nanp_valid(raw: &str) -> bool {
    let d: String = raw.chars().filter(|c| c.is_ascii_digit()).collect();
    let nat = if d.len() == 11 { &d[1..] } else { &d[..] };
    nanp_national_valid(nat) && !all_same(nat) && !sequential(nat)
}

/* ------------------------------------------------------------------ */
/* Boundaries: a candidate must not be part of a longer token          */
/* (letters and digits of any script count as part of a token)        */
/* ------------------------------------------------------------------ */

fn char_before(text: &str, start: usize) -> Option<char> {
    text[..start].chars().next_back()
}

fn char_after(text: &str, end: usize) -> Option<char> {
    text[end..].chars().next()
}

/// `true` when the match is followed by `.`/`,`/`-` and a digit
/// (a decimal number or a longer dashed number).
fn continues_number(text: &str, end: usize, seps: &[char]) -> bool {
    let mut rest = text[end..].chars();
    matches!(rest.next(), Some(c) if seps.contains(&c))
        && matches!(rest.next(), Some(c) if c.is_ascii_digit())
}

fn card_bounded(text: &str, s: usize, e: usize) -> bool {
    let before_ok =
        !matches!(char_before(text, s), Some(c) if c.is_alphanumeric() || ".,_-".contains(c));
    let after_ok = !matches!(char_after(text, e), Some(c) if c.is_alphanumeric() || c == '_')
        && !continues_number(text, e, &['.', ',']);
    before_ok && after_ok
}

fn ssn_bounded(text: &str, s: usize, e: usize) -> bool {
    let before_ok =
        !matches!(char_before(text, s), Some(c) if c.is_alphanumeric() || ".-".contains(c));
    let after_ok = !matches!(char_after(text, e), Some(c) if c.is_alphanumeric())
        && !continues_number(text, e, &['-']);
    before_ok && after_ok
}

/// E.164: the Node.js scrubber's boundaries.
fn e164_bounded(text: &str, s: usize, e: usize) -> bool {
    !matches!(char_before(text, s), Some(c) if c.is_alphanumeric() || c == '+')
        && !matches!(char_after(text, e), Some(c) if c.is_numeric())
}

/// Formatted NANP numbers have no `+`, so they need stricter boundaries
/// to stay out of version strings and longer dashed numbers.
fn nanp_bounded(text: &str, s: usize, e: usize) -> bool {
    let before_ok =
        !matches!(char_before(text, s), Some(c) if c.is_alphanumeric() || "+_-".contains(c));
    let after_ok = !matches!(char_after(text, e), Some(c) if c.is_alphanumeric() || c == '_')
        && !continues_number(text, e, &['.', ',', '-']);
    before_ok && after_ok
}

type Check = fn(&str) -> bool;
type Bound = fn(&str, usize, usize) -> bool;

/// Spans of `re` matches that stand on their own and pass `valid`.
///
/// The regex crate has no lookaround and does not backtrack into a match
/// that fails these checks, so when a candidate fails, shorter versions of
/// it (ending at an earlier digit) are tried, longest first. This keeps
/// "4111 1111 1111 1111 2025" or two cards separated by a space redacted.
fn checked_spans(re: &Regex, text: &str, bound: Bound, valid: Check) -> Vec<(usize, usize)> {
    let mut spans = Vec::new();
    let mut pos = 0;
    while pos < text.len() {
        let Some(m) = re.find_at(text, pos) else {
            break;
        };
        let (s, e) = (m.start(), m.end());
        let found = (s + 1..=e)
            .rev()
            .filter(|&end| text.as_bytes()[end - 1].is_ascii_digit())
            .find(|&end| bound(text, s, end) && valid(&text[s..end]));
        match found {
            Some(end) => {
                spans.push((s, end));
                pos = end;
            }
            None => pos = e,
        }
    }
    spans
}

fn replace_spans(text: &str, spans: &[(usize, usize)], marker: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut last = 0;
    for &(s, e) in spans {
        out.push_str(&text[last..s]);
        out.push_str(marker);
        last = e;
    }
    out.push_str(&text[last..]);
    out
}

fn card_spans(text: &str) -> Vec<(usize, usize)> {
    checked_spans(card_re(), text, card_bounded, card_valid)
}

fn ssn_spans(text: &str) -> Vec<(usize, usize)> {
    checked_spans(ssn_re(), text, ssn_bounded, ssn_valid)
}

fn e164_spans(text: &str) -> Vec<(usize, usize)> {
    checked_spans(e164_re(), text, e164_bounded, e164_valid)
}

fn nanp_spans(text: &str) -> Vec<(usize, usize)> {
    checked_spans(nanp_re(), text, nanp_bounded, formatted_nanp_valid)
}

fn scrub_json_value(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::String(s) => *s = Scrubber::scrub(s),
        serde_json::Value::Array(items) => items.iter_mut().for_each(scrub_json_value),
        serde_json::Value::Object(map) => map.values_mut().for_each(scrub_json_value),
        _ => {}
    }
}

impl Scrubber {
    /// Scrub all PII and sensitive data from the input string
    ///
    /// # Arguments
    /// * `input` - The string to scrub
    ///
    /// # Returns
    /// A new string with all sensitive data replaced with redaction markers
    ///
    /// # Example
    /// ```
    /// use zn::scrubber::Scrubber;
    ///
    /// let input = "Contact user@example.com with api_key=fakekeyfakekeyfakekey";
    /// let scrubbed = Scrubber::scrub(input);
    /// assert!(scrubbed.contains("[EMAIL_REDACTED]"));
    /// assert!(scrubbed.contains("[SECRET_REDACTED]"));
    /// ```
    pub fn scrub(input: &str) -> String {
        // Apply scrubbing in order of specificity
        let mut output = scrub_cloud_keys(input);
        output = jwt_re().replace_all(&output, "[JWT_REDACTED]").to_string();
        output = email_re()
            .replace_all(&output, "[EMAIL_REDACTED]")
            .to_string();
        output = api_re()
            .replace_all(&output, "$1: [SECRET_REDACTED]")
            .to_string();
        output = replace_spans(&output, &card_spans(&output), "[CARD_REDACTED]");
        output = replace_spans(&output, &ssn_spans(&output), "[SSN_REDACTED]");
        output = replace_spans(&output, &e164_spans(&output), "[PHONE_REDACTED]");
        output = replace_spans(&output, &nanp_spans(&output), "[PHONE_REDACTED]");

        output
    }

    /// Scrub one JSON-RPC line without breaking its structure.
    ///
    /// A line that parses as JSON is scrubbed value by value (every string,
    /// at any depth; object keys are kept) and written back as JSON, so a
    /// secret at the end of a string cannot swallow the closing quote. A line
    /// that is not JSON is scrubbed as plain text, as before.
    pub fn scrub_json_line(line: &str) -> String {
        match serde_json::from_str::<serde_json::Value>(line) {
            Ok(mut value) => {
                scrub_json_value(&mut value);
                serde_json::to_string(&value).unwrap_or_else(|_| Self::scrub(line))
            }
            Err(_) => Self::scrub(line),
        }
    }

    /// Check if a string contains any detectable PII
    ///
    /// # Arguments
    /// * `input` - The string to check
    ///
    /// # Returns
    /// `true` if any PII patterns are detected
    pub fn contains_pii(input: &str) -> bool {
        let scrubbed = Self::scrub(input);
        scrubbed != input
    }

    /// Get a list of PII types found in the input
    ///
    /// # Returns
    /// A vector of PII type names found in the input
    pub fn detect_pii_types(input: &str) -> Vec<&'static str> {
        let mut types = Vec::new();

        if email_re().is_match(input) {
            types.push("email");
        }
        if api_re().is_match(input) {
            types.push("api_key_or_secret");
        }
        if !card_spans(input).is_empty() {
            types.push("credit_card");
        }
        if !ssn_spans(input).is_empty() {
            types.push("ssn");
        }
        if !e164_spans(input).is_empty() || !nanp_spans(input).is_empty() {
            types.push("phone");
        }
        if jwt_re().is_match(input) {
            types.push("jwt");
        }
        if scrub_cloud_keys(input) != input {
            types.push("cloud_key");
        }

        types
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_scrub_email() {
        let input = "Contact user@example.com for help";
        let scrubbed = Scrubber::scrub(input);
        assert!(scrubbed.contains("[EMAIL_REDACTED]"));
        assert!(!scrubbed.contains("user@example.com"));
    }

    #[test]
    fn test_scrub_api_key() {
        // Placeholder value chosen with deliberately low character variety:
        // secret scanners (gitleaks generic-api-key) skip it as a non-secret,
        // while the scrubber regex still matches any 8+ char assignment.
        let input = "api_key=fakekeyfakekeyfakekey";
        let scrubbed = Scrubber::scrub(input);
        assert!(scrubbed.contains("[SECRET_REDACTED]"));
        assert!(!scrubbed.contains("fakekeyfakekeyfakekey"));
    }

    #[test]
    fn test_scrub_credit_card() {
        for input in [
            "Card: 4111-1111-1111-1111",
            "Card: 4111 1111 1111 1111.",
            "card=4111111111111111",
            "Amex 378282246310005",
            "exp 4111 1111 1111 1111 2025",
        ] {
            let scrubbed = Scrubber::scrub(input);
            assert!(scrubbed.contains("[CARD_REDACTED]"), "{input}");
        }
    }

    #[test]
    fn test_cards_next_to_other_digits() {
        let out = Scrubber::scrub("cards: 4111111111111111 5500000000000004");
        assert_eq!(out, "cards: [CARD_REDACTED] [CARD_REDACTED]");
        let out = Scrubber::scrub("card 4111 1111 1111 1111 2025");
        assert_eq!(out, "card [CARD_REDACTED] 2025");
        let out = Scrubber::scrub("card 4111 1111 1111 1111 12/25");
        assert!(out.starts_with("card [CARD_REDACTED]"), "{out}");
        // Digits from other scripts are not part of a card number.
        let out = Scrubber::scrub("card 4111111111111111\u{0663}");
        assert!(!out.contains("[CARD_REDACTED]"), "{out}");
    }

    #[test]
    fn test_card_needs_luhn_network_and_boundaries() {
        for input in [
            "Card: 4111-1111-1111-1112",  // fails Luhn
            "id 1234567812345670",        // passes Luhn, no card network
            "Card: 4111 1111-1111 1111",  // mixed separators
            "order-4111111111111111",     // part of a longer token
            "x4111111111111111",          // part of a word
            "amount 4111111111111111.50", // decimal number
            "0000000000000000",           // repeated digit
        ] {
            assert!(
                !Scrubber::scrub(input).contains("[CARD_REDACTED]"),
                "{input}"
            );
        }
    }

    #[test]
    fn test_scrub_ssn() {
        let input = "SSN: 123-45-6789";
        let scrubbed = Scrubber::scrub(input);
        assert!(scrubbed.contains("[SSN_REDACTED]"));
    }

    #[test]
    fn test_ssn_needs_valid_parts_and_boundaries() {
        for input in [
            "SSN: 000-45-6789",
            "SSN: 666-45-6789",
            "SSN: 912-45-6789",
            "SSN: 123-00-6789",
            "SSN: 123-45-0000",
            "ref 1123-45-6789",
            "ref 123-45-6789-1",
            "v1.123-45-6789",
        ] {
            assert!(
                !Scrubber::scrub(input).contains("[SSN_REDACTED]"),
                "{input}"
            );
        }
    }

    #[test]
    fn test_scrub_phone() {
        for input in [
            "Call me at (415) 555-2671",
            "Call me at 415-555-2671.",
            "Call me at +1 415 555 2671",
            "Call +34612345678 tomorrow",
            "Ring +447911123456 today",
            "Tel.415-555-2671",
            "wa.me/+14155552671",
            "call +14155552671-2",
        ] {
            let scrubbed = Scrubber::scrub(input);
            assert!(scrubbed.contains("[PHONE_REDACTED]"), "{input}");
        }
    }

    #[test]
    fn test_phone_needs_valid_number_and_boundaries() {
        for input in [
            "ts 1728900000",             // bare ten digits: an ID or timestamp
            "order 98234155526710",      // ten digits inside a longer number
            "Call me at (555) 123-4567", // exchange code cannot start with 1
            "Call me at (155) 523-4567", // area code cannot start with 1
            "sku 415-555-2671-9",        // part of a longer dashed number
            "id A415-555-2671",          // part of a word
            "+34 has +3461234567",       // wrong length for +34
            "+11111111111",              // repeated digit
            "+441234567890",             // sequential digits
        ] {
            assert!(
                !Scrubber::scrub(input).contains("[PHONE_REDACTED]"),
                "{input}"
            );
        }
    }

    #[test]
    fn test_scrub_jwt() {
        // Token assembled at runtime from fragments so secret scanners do not
        // mistake this synthetic example for a real credential; the scrubber
        // still sees a well-formed header.payload.signature token.
        let input = format!(
            "Authorization: Bearer {}",
            [
                "eyJhbGciOiJIUzI1NiJ9",
                "eyJzdWIiOiJ1c2VyIn0",
                "signature123"
            ]
            .join(".")
        );
        let scrubbed = Scrubber::scrub(&input);
        assert!(scrubbed.contains("[JWT_REDACTED]"));
    }

    #[test]
    fn test_contains_pii() {
        assert!(Scrubber::contains_pii("email: test@example.com"));
        assert!(!Scrubber::contains_pii("This has no PII"));
        assert!(!Scrubber::contains_pii(
            "started at 1728900000, pid 4155552671"
        ));
    }

    #[test]
    fn test_detect_pii_types() {
        let input = "Email: user@test.com, SSN: 123-45-6789, phone (415) 555-2671";
        let types = Scrubber::detect_pii_types(input);
        assert!(types.contains(&"email"));
        assert!(types.contains(&"ssn"));
        assert!(types.contains(&"phone"));
        assert!(!Scrubber::detect_pii_types("Card: 4111-1111-1111-1112").contains(&"credit_card"));
    }

    #[test]
    fn test_preserves_safe_content() {
        let input = "This is a safe message with no PII";
        let scrubbed = Scrubber::scrub(input);
        assert_eq!(input, scrubbed);
    }

    // Fake keys are assembled at runtime so secret scanners do not flag them.
    fn fake_google_key() -> String {
        format!("AIza{}", "SyFAKE".repeat(5) + "FAKEF")
    }

    fn fake_azure_key() -> String {
        format!("AccountKey={}==", "Ab1/".repeat(21) + "Ab")
    }

    #[test]
    fn test_scrub_aws_access_key() {
        let out = Scrubber::scrub("key AKIAIOSFODNN7EXAMPLE here");
        assert_eq!(out, "key [AWS_KEY_REDACTED] here");
        for prefix in ["ASIA", "ABIA", "ACCA"] {
            let input = format!("id={prefix}IOSFODNN7EXAMPLE;");
            assert_eq!(Scrubber::scrub(&input), "id=[AWS_KEY_REDACTED];", "{input}");
        }
        assert!(Scrubber::contains_pii("AKIAIOSFODNN7EXAMPLE"));
        assert!(Scrubber::detect_pii_types("AKIAIOSFODNN7EXAMPLE").contains(&"cloud_key"));
    }

    #[test]
    fn test_scrub_aws_secret_key_in_context() {
        let secret = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
        for input in [
            format!("aws_secret_access_key = {secret}"),
            format!("AWS_SECRET_ACCESS_KEY={secret}"),
            format!("\"SecretAccessKey\": \"{secret}\""),
        ] {
            let out = Scrubber::scrub(&input);
            assert!(out.contains("[AWS_SECRET_REDACTED]"), "{out}");
            assert!(!out.contains(secret), "{out}");
        }
        // The same 40 characters without a name are not redacted.
        let bare = format!("checksum {secret}");
        assert_eq!(Scrubber::scrub(&bare), bare);
    }

    #[test]
    fn test_scrub_google_and_azure_keys() {
        let g = fake_google_key();
        assert_eq!(g.len(), 39);
        let out = Scrubber::scrub(&format!("key={g}&x=1"));
        assert_eq!(out, "key=[GOOGLE_API_KEY_REDACTED]&x=1");
        let a = fake_azure_key();
        let out = Scrubber::scrub(&format!(
            "DefaultEndpointsProtocol=https;AccountName=x;{a};EndpointSuffix=core.windows.net"
        ));
        assert!(
            out.contains("AccountKey=[AZURE_STORAGE_KEY_REDACTED];"),
            "{out}"
        );
        assert!(!out.contains("Ab1/Ab1/"), "{out}");
    }

    #[test]
    fn test_scrub_private_key_block() {
        let body = "QUJD".repeat(20);
        // Markers split so secret scanners do not mistake the fake block for a key.
        let (begin, end) = ("-----BEGIN PRIVATE", "KEY-----");
        let pem = format!("{begin} {end}\n{body}\n-----END PRIVATE {end}\n");
        let out = Scrubber::scrub(&format!("before {pem} after"));
        assert_eq!(out, "before [PRIVATE_KEY_REDACTED]\n after");
        // JSON-escaped line breaks, as in a service-account file.
        let escaped =
            format!("{{\"private_key\": \"{begin} {end}\\n{body}\\n-----END PRIVATE {end}\\n\"}}");
        let out = Scrubber::scrub(&escaped);
        assert!(
            out.contains("[PRIVATE_KEY_REDACTED]") && !out.contains(&body),
            "{out}"
        );
        // Cut off before the END line.
        let cut = format!("-----BEGIN RSA PRIVATE KEY-----\n{body}");
        assert_eq!(Scrubber::scrub(&cut), "[PRIVATE_KEY_REDACTED]");
    }

    #[test]
    fn test_cloud_patterns_leave_normal_text_alone() {
        for input in [
            "AKIA is the prefix of an AWS access key id",
            "AKIAIOSFODNN7EXAMPLEEXTRA",
            "xAKIAIOSFODNN7EXAMPLE",
            "AKIAAAAAAAAAAAAAAAAA",
            "AIza is Google's key prefix",
            "AIzaShort",
            "the secret access key is stored in the vault",
            "AccountKey=not-a-real-key",
            "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----",
            "-----BEGIN PRIVATE KEY----- is how a PEM block starts",
        ] {
            assert_eq!(Scrubber::scrub(input), input, "{input}");
        }
    }

    #[test]
    fn test_scrub_json_line_secret_at_end_of_string() {
        let line = r#"{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"run","arguments":{"cmd":"export api_key=fakekeyfakekeyfakekey","note":"AKIAIOSFODNN7EXAMPLE"}}}"#;
        let out = Scrubber::scrub_json_line(line);
        let v: serde_json::Value = serde_json::from_str(&out).expect("still valid JSON");
        assert_eq!(v["id"], 7);
        assert_eq!(v["params"]["arguments"]["note"], "[AWS_KEY_REDACTED]");
        assert!(v["params"]["arguments"]["cmd"]
            .as_str()
            .unwrap()
            .contains("[SECRET_REDACTED]"));
        assert!(!out.contains("fakekeyfakekeyfakekey"));
        // The old whole-line scrub ate the closing quote and broke the message.
        assert!(serde_json::from_str::<serde_json::Value>(&Scrubber::scrub(line)).is_err());
        // And the validator accepts the scrubbed line.
        assert!(matches!(
            crate::jsonrpc::validate_jsonrpc(&out),
            crate::jsonrpc::JsonRpcValidation::ToolCall { .. }
        ));
    }

    #[test]
    fn test_scrub_json_line_keeps_keys_and_non_json() {
        let out = Scrubber::scrub_json_line(r#"{"user@example.com":"hi user@example.com","n":1}"#);
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["user@example.com"], "hi [EMAIL_REDACTED]");
        assert_eq!(v["n"], 1);
        assert_eq!(
            Scrubber::scrub_json_line("not json user@example.com"),
            "not json [EMAIL_REDACTED]"
        );
    }

    #[test]
    fn test_validators_match_node() {
        assert!(luhn_valid("4111111111111111"));
        assert!(!luhn_valid("4111111111111112"));
        assert!(e164_valid("+14155552671"));
        assert!(!e164_valid("+11555552671"));
        assert!(!e164_valid("+0123456789"));
        assert!(ssn_valid("123-45-6789"));
        assert!(!ssn_valid("900-45-6789"));
    }
}
