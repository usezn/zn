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

fn email_re() -> &'static Regex {
    EMAIL_REGEX
        .get_or_init(|| Regex::new(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}").unwrap())
}

fn api_re() -> &'static Regex {
    API_KEY_REGEX.get_or_init(|| {
        // Matches: api_key=xxx, secret: xxx, password=xxx, token: xxx
        // Requires at least 8 characters for the value (reduced from 16 for better detection)
        Regex::new(r#"(?i)(api[_-]?key|secret[_-]?access[_-]?key|secret[_-]?key|secret|private[_-]?key|passwd|passphrase|password|credentials?|token|auth[_-]?token|access[_-]?token|bearer)[ ]*[:=][ ]*['"]?([a-zA-Z0-9_\-.]{8,})['"]?"#).unwrap()
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
    if raw.len() < 13 {
        return false;
    }
    // One kind of separator only: "4111 1111-1111 1111" is not a card number.
    let has_space = raw.contains(' ');
    let has_dash = raw.contains('-');
    if has_space && has_dash {
        return false;
    }
    // At most 19 digits: collect them on the stack (this runs for every
    // candidate start in long inputs).
    let mut buf = [0u8; 19];
    let mut n = 0;
    for b in raw.bytes().filter(u8::is_ascii_digit) {
        if n == buf.len() {
            return false;
        }
        buf[n] = b;
        n += 1;
    }
    let Ok(d) = std::str::from_utf8(&buf[..n]) else {
        return false;
    };
    if n < 13 || all_same(d) {
        return false;
    }
    card_network_ok(d) && luhn_valid(d)
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

fn card_lead(text: &str, s: usize) -> bool {
    !matches!(char_before(text, s), Some(c) if c.is_alphanumeric() || ".,_-".contains(c))
}

fn card_trail(text: &str, e: usize) -> bool {
    !matches!(char_after(text, e), Some(c) if c.is_alphanumeric() || c == '_')
        && !continues_number(text, e, &['.', ','])
}

fn ssn_lead(text: &str, s: usize) -> bool {
    !matches!(char_before(text, s), Some(c) if c.is_alphanumeric() || ".-".contains(c))
}

fn ssn_trail(text: &str, e: usize) -> bool {
    !matches!(char_after(text, e), Some(c) if c.is_alphanumeric())
        && !continues_number(text, e, &['-'])
}

/// E.164: the Node.js scrubber's boundaries.
fn e164_lead(text: &str, s: usize) -> bool {
    !matches!(char_before(text, s), Some(c) if c.is_alphanumeric() || c == '+')
}

fn e164_trail(text: &str, e: usize) -> bool {
    !matches!(char_after(text, e), Some(c) if c.is_numeric())
}

/// Formatted NANP numbers have no `+`, so they need stricter boundaries
/// to stay out of version strings and longer dashed numbers.
fn nanp_lead(text: &str, s: usize) -> bool {
    !matches!(char_before(text, s), Some(c) if c.is_alphanumeric() || "+_-".contains(c))
}

fn nanp_trail(text: &str, e: usize) -> bool {
    !matches!(char_after(text, e), Some(c) if c.is_alphanumeric() || c == '_')
        && !continues_number(text, e, &['.', ',', '-'])
}

type Check = fn(&str) -> bool;
/// Leading boundary: depends only on the text before the start.
type Lead = fn(&str, usize) -> bool;
/// Trailing boundary: depends only on the text after the end.
type Trail = fn(&str, usize) -> bool;

/// Spans of `re` matches that stand on their own and pass `valid`.
///
/// The regex crate has no lookaround and does not backtrack into a match
/// that fails these checks, so when a candidate fails, shorter versions of
/// it (ending at an earlier digit) are tried, longest first. This keeps
/// "4111 1111 1111 1111 2025" or two cards separated by a space redacted.
///
/// When a candidate fails its leading boundary, a real match can still start
/// inside it (a card right after an IBAN-like token), so the search resumes at
/// the next start that passes the leading boundary, not at the candidate's
/// end. Starts that fail it are skipped without running the regex or the
/// validators, which keeps long runs of digits or letters linear.
fn checked_spans(
    re: &Regex,
    text: &str,
    lead: Lead,
    trail: Trail,
    valid: Check,
) -> Vec<(usize, usize)> {
    let mut spans = Vec::new();
    let mut pos = 0;
    while pos < text.len() {
        let Some(m) = re.find_at(text, pos) else {
            break;
        };
        let (s, e) = (m.start(), m.end());
        let found = if lead(text, s) {
            (s + 1..=e)
                .rev()
                .filter(|&end| text.as_bytes()[end - 1].is_ascii_digit())
                .find(|&end| trail(text, end) && valid(&text[s..end]))
        } else {
            None
        };
        match found {
            Some(end) => {
                spans.push((s, end));
                pos = end;
            }
            None => {
                // Matches are ASCII, so every offset up to `e` is a char boundary.
                pos = s + 1;
                while pos < e && !lead(text, pos) {
                    pos += 1;
                }
            }
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
    checked_spans(card_re(), text, card_lead, card_trail, card_valid)
}

fn ssn_spans(text: &str) -> Vec<(usize, usize)> {
    checked_spans(ssn_re(), text, ssn_lead, ssn_trail, ssn_valid)
}

fn e164_spans(text: &str) -> Vec<(usize, usize)> {
    checked_spans(e164_re(), text, e164_lead, e164_trail, e164_valid)
}

fn nanp_spans(text: &str) -> Vec<(usize, usize)> {
    checked_spans(nanp_re(), text, nanp_lead, nanp_trail, formatted_nanp_valid)
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
        let mut output = jwt_re().replace_all(input, "[JWT_REDACTED]").to_string();
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
    fn test_card_after_failed_boundary_candidate() {
        // The first candidate starts inside the IBAN-like token and fails its
        // leading boundary; the card after the space must still be found.
        let out = Scrubber::scrub("GB82WEST12345698765432 4111111111111111");
        assert_eq!(out, "GB82WEST12345698765432 [CARD_REDACTED]");
        let out = Scrubber::scrub("A4111 1111 1111 1111 4111111111111111");
        assert_eq!(out, "A4111 1111 1111 1111 [CARD_REDACTED]");
        let out = Scrubber::scrub("ref x12345698765432 4111-1111-1111-1111 end");
        assert_eq!(out, "ref x12345698765432 [CARD_REDACTED] end");
    }

    #[test]
    fn test_phone_after_failed_boundary_candidate() {
        // "1 212-456-7890" is rejected (preceded by a dash); the number that
        // starts after the space is a separate, standalone match.
        let out = Scrubber::scrub("-1 212-456-7890 ok");
        assert_eq!(out, "-1 [PHONE_REDACTED] ok");
    }

    #[test]
    fn test_failed_boundary_retry_keeps_negatives() {
        for input in [
            "order-4111111111111111",
            "x4111111111111111",
            "GB82WEST123456987654324111111111111111",
            "amount 4111111111111111.50",
            "id 1234567812345670",
            "x4111 1111 1111 1111",
        ] {
            assert!(
                !Scrubber::scrub(input).contains("[CARD_REDACTED]"),
                "{input}"
            );
        }
        assert!(!Scrubber::scrub("A123-45-6789").contains("[SSN_REDACTED]"));
    }

    #[test]
    fn test_failed_boundary_retry_stays_fast() {
        // Long runs where every candidate fails: time must stay linear.
        let digits = "1234567890".repeat(104_858);
        let mixed = "ab12 ".repeat(209_716);
        let dashed = "x1-1-1-".repeat(150_000);
        let spaced = "1111 ".repeat(209_716);
        let hyphens = "1111-111-".repeat(116_508);
        let plus = "+1234567".repeat(131_072);
        let start = std::time::Instant::now();
        for input in [&digits, &mixed, &dashed, &spaced, &hyphens, &plus] {
            let _ = Scrubber::scrub(input);
        }
        assert!(
            start.elapsed() < std::time::Duration::from_secs(5),
            "{:?}",
            start.elapsed()
        );
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
