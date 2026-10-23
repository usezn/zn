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
//! - IBANs (country length and mod-97 checksum) → `[IBAN_REDACTED]`
//! - Spanish DNI and NIE (check letter) → `[DNI_REDACTED]`, `[NIE_REDACTED]`
//! - IPv4 addresses (public ones only; **off by default**) → `[IPV4_REDACTED]`
//! - A person's name, a postal address and a username, only from an explicit key next to the
//!   value (an HTTP header such as `X-User-Name`, or a query or form key such as `name=`) →
//!   `[PERSON_NAME_REDACTED]`, `[POSTAL_ADDRESS_REDACTED]`, `[USERNAME_REDACTED]`
//!
//! Which PII types are redacted is a [`PiiOptions`] value, as in the Node.js scrubber's `pii`
//! option: everything on except IPv4. Secrets are always redacted.
//!
//! Card, SSN and phone candidates must stand on their own (not be part of a
//! longer number or word) and pass the same checks as the Node.js scrubber,
//! so IDs, timestamps and other long digit runs are left alone.
//!
//! ## Performance
//! Regex patterns are compiled once and cached using `OnceLock` for optimal performance.

mod invisible;
mod keyed;

use regex::Regex;
use std::sync::OnceLock;

/// PII Scrubber for sanitizing sensitive data
pub struct Scrubber;

/// Which PII types the scrubber redacts (the `pii` option of the Node.js scrubber, with the
/// same defaults: everything on except `ipv4`). Secrets, JWTs and Authorization headers are
/// always redacted.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PiiOptions {
    pub email: bool,
    pub phone: bool,
    pub iban: bool,
    pub card: bool,
    /// Spanish DNI and NIE.
    pub dni: bool,
    pub ssn: bool,
    pub ipv4: bool,
    /// A person's name next to an explicit key (`X-User-Name`, `name=`).
    pub name: bool,
    /// A postal address next to an explicit key (`X-Address`, `address=`).
    pub address: bool,
    /// A username next to an explicit key (`X-Username`, `user=`).
    pub username: bool,
}

impl Default for PiiOptions {
    fn default() -> Self {
        PiiOptions {
            email: true,
            phone: true,
            iban: true,
            card: true,
            dni: true,
            ssn: true,
            ipv4: false,
            name: true,
            address: true,
            username: true,
        }
    }
}

impl PiiOptions {
    /// No PII type at all (secrets are still redacted).
    pub fn none() -> Self {
        PiiOptions {
            email: false,
            phone: false,
            iban: false,
            card: false,
            dni: false,
            ssn: false,
            ipv4: false,
            name: false,
            address: false,
            username: false,
        }
    }
}

// Compiled regex patterns (initialized once)
static EMAIL_REGEX: OnceLock<Regex> = OnceLock::new();
static API_KEY_REGEX: OnceLock<Regex> = OnceLock::new();
static CREDIT_CARD_REGEX: OnceLock<Regex> = OnceLock::new();
static SSN_REGEX: OnceLock<Regex> = OnceLock::new();
static E164_REGEX: OnceLock<Regex> = OnceLock::new();
static NANP_REGEX: OnceLock<Regex> = OnceLock::new();
static JWT_REGEX: OnceLock<Regex> = OnceLock::new();
static AUTH_HEADER_REGEX: OnceLock<Regex> = OnceLock::new();
static AUTH_PLACEHOLDER_REGEX: OnceLock<Regex> = OnceLock::new();
static IBAN_REGEX: OnceLock<(Regex, Regex)> = OnceLock::new();
static DNI_REGEX: OnceLock<(Regex, Regex)> = OnceLock::new();
static NIE_REGEX: OnceLock<(Regex, Regex)> = OnceLock::new();
static IPV4_REGEX: OnceLock<(Regex, Regex)> = OnceLock::new();

fn email_re() -> &'static Regex {
    EMAIL_REGEX
        .get_or_init(|| Regex::new(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}").unwrap())
}

fn api_re() -> &'static Regex {
    API_KEY_REGEX.get_or_init(|| {
        // Matches: api_key=xxx, secret: xxx, password=xxx, token: xxx, and the same as a JSON
        // member ("api_key": "xxx"), also inside a JSON string (\"api_key\":\"xxx\").
        // Group 1 is the name, group 2 the optional quote that closes it, group 3 the optional
        // quote that opens the value (both may be backslash-escaped), group 4 the value.
        // Requires at least 8 characters for the value (reduced from 16 for better detection).
        // A value split by shell quotes ('ab''cd', ab""cd) is one word: redact all of it.
        Regex::new(r#"(?i)(api[_-]?key|secret[_-]?key|password|token|auth[_-]?token|access[_-]?token|bearer)(\\{0,2}['"])?[ \t]*[:=][ \t]*(\\{0,2}['"])?([a-zA-Z0-9_\-.]{8,})(?:\\{0,2}['"])?(?:['"]+[a-zA-Z0-9_\-.]*)*"#).unwrap()
    })
}

/// `Authorization: Bearer <token>` (also Basic and Token, quoted, escaped or in a JSON member).
/// Group 1 is the header up to the token, group 2 the token. The Node scrubber has the same rule.
fn auth_re() -> &'static Regex {
    AUTH_HEADER_REGEX.get_or_init(|| {
        Regex::new(r#"(?i)((?:proxy-)?authorization(?:\\{0,2}['"])?[ \t]*[:=][ \t]*(?:\\{0,2}['"])?(?:bearer|basic|token)[ \t]+)([A-Za-z0-9._~+/=-]{8,512})"#).unwrap()
    })
}

/// Words that start a template or a prose example ("your_token_here", "token", "xxx").
fn auth_placeholder_re() -> &'static Regex {
    AUTH_PLACEHOLDER_REGEX.get_or_init(|| {
        Regex::new(r"(?i)^(?:your|my|an?|the|insert|put|paste|token|api|key|secret|access|auth|bearer|xxx|redacted)[-_a-z]*$|^[-_.=*x]+$|^(?:process\.env|os\.environ|os\.getenv|env\.|secrets\.|vars\.|config\.|settings\.|self\.|this\.|arn:)").unwrap()
    })
}

/// A credential in an Authorization header looks random: it is not a placeholder or a
/// reference and has a digit, or is long, or mixes cases (the Node scrubber's rule).
fn auth_token_ok(token: &str) -> bool {
    token.len() >= 8
        && !token.contains("__ZN_")
        && !auth_placeholder_re().is_match(token)
        && (token.bytes().any(|b| b.is_ascii_digit())
            || token.len() >= 20
            || (token.len() >= 16
                && token.bytes().any(|b| b.is_ascii_lowercase())
                && token.bytes().any(|b| b.is_ascii_uppercase())))
}

/// Replacement for one auth_re() match: keep the header, redact the token (not a final `.`).
fn redact_auth(caps: &regex::Captures) -> String {
    let token = &caps[2];
    let core = token.trim_end_matches('.');
    if auth_token_ok(core) {
        format!("{}[SECRET_REDACTED]{}", &caps[1], &token[core.len()..])
    } else {
        caps[0].to_string()
    }
}

/// Replacement for one api_re() match. A plain `name=value` becomes `name: [SECRET_REDACTED]`.
/// A quoted name (a JSON member) keeps its quotes, so the output is still valid JSON.
fn redact_secret(caps: &regex::Captures) -> String {
    let name = &caps[1];
    match caps.get(2) {
        None => format!("{name}: [SECRET_REDACTED]"),
        Some(key_quote) => {
            let value_quote = caps.get(3).map_or("", |m| m.as_str());
            format!(
                "{name}{}: {value_quote}[SECRET_REDACTED]{value_quote}",
                key_quote.as_str()
            )
        }
    }
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

/// A candidate pattern and the same pattern anchored at both ends (to test shorter ends).
fn pair(src: &str) -> (Regex, Regex) {
    (
        Regex::new(src).unwrap(),
        Regex::new(&format!("^(?:{src})$")).unwrap(),
    )
}

fn iban_re() -> &'static (Regex, Regex) {
    // Two letters, two digits, then 2-7 groups of four and an optional shorter last group.
    IBAN_REGEX.get_or_init(|| pair(r"[A-Z]{2}[0-9]{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?"))
}

fn dni_re() -> &'static (Regex, Regex) {
    DNI_REGEX.get_or_init(|| pair(r"[0-9]{8}-?[A-Z]"))
}

fn nie_re() -> &'static (Regex, Regex) {
    NIE_REGEX.get_or_init(|| pair(r"[XYZ]-?[0-9]{7}-?[A-Z]"))
}

fn ipv4_re() -> &'static (Regex, Regex) {
    IPV4_REGEX.get_or_init(|| pair(r"(?:[0-9]{1,3}\.){3}[0-9]{1,3}"))
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

/// IBAN lengths per country (ISO 13616 registry, SEPA and common others; the Node.js table).
const IBAN_LENGTHS: &[(&str, usize)] = &[
    ("AD", 24),
    ("AE", 23),
    ("AL", 28),
    ("AT", 20),
    ("AZ", 28),
    ("BA", 20),
    ("BE", 16),
    ("BG", 22),
    ("BH", 22),
    ("BR", 29),
    ("CH", 21),
    ("CR", 22),
    ("CY", 28),
    ("CZ", 24),
    ("DE", 22),
    ("DK", 18),
    ("DO", 28),
    ("EE", 20),
    ("EG", 29),
    ("ES", 24),
    ("FI", 18),
    ("FO", 18),
    ("FR", 27),
    ("GB", 22),
    ("GE", 22),
    ("GI", 23),
    ("GL", 18),
    ("GR", 27),
    ("GT", 28),
    ("HR", 21),
    ("HU", 28),
    ("IE", 22),
    ("IL", 23),
    ("IS", 26),
    ("IT", 27),
    ("JO", 30),
    ("KW", 30),
    ("KZ", 20),
    ("LB", 28),
    ("LI", 21),
    ("LT", 20),
    ("LU", 20),
    ("LV", 21),
    ("MC", 27),
    ("MD", 24),
    ("ME", 22),
    ("MK", 19),
    ("MR", 27),
    ("MT", 31),
    ("MU", 30),
    ("NL", 18),
    ("NO", 15),
    ("PK", 24),
    ("PL", 28),
    ("PS", 29),
    ("PT", 25),
    ("QA", 29),
    ("RO", 24),
    ("RS", 22),
    ("SA", 24),
    ("SE", 24),
    ("SI", 19),
    ("SK", 24),
    ("SM", 27),
    ("TN", 24),
    ("TR", 26),
    ("UA", 29),
    ("VG", 24),
    ("XK", 20),
];

/// ISO 7064 mod 97-10: letters count as 10..35, the first four characters move to the end.
fn mod97(iban: &str) -> u32 {
    let mut rem = 0u32;
    for c in iban[4..].chars().chain(iban[..4].chars()) {
        match c {
            'A'..='Z' => rem = (rem * 100 + (c as u32 - 55)) % 97,
            _ => rem = (rem * 10 + (c as u32 - 48)) % 97,
        }
    }
    rem
}

fn iban_valid(raw: &str) -> bool {
    let iban: String = raw
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-')
        .map(|c| c.to_ascii_uppercase())
        .collect();
    if !iban.is_ascii() || iban.len() < 5 {
        return false;
    }
    let Some(&(_, len)) = IBAN_LENGTHS.iter().find(|(c, _)| *c == &iban[..2]) else {
        return false;
    };
    if iban.len() != len {
        return false;
    }
    let b = iban.as_bytes();
    if !(b[0].is_ascii_uppercase()
        && b[1].is_ascii_uppercase()
        && b[2].is_ascii_digit()
        && b[3].is_ascii_digit()
        && b[4..]
            .iter()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit()))
    {
        return false;
    }
    mod97(&iban) == 1
}

const DNI_LETTERS: &[u8; 23] = b"TRWAGMYFPDXBNJZSQVHLCKE";

/// DNI: 8 digits and the check letter `DNI_LETTERS[number % 23]`.
fn dni_valid(raw: &str) -> bool {
    let v: Vec<u8> = raw
        .bytes()
        .filter(|&c| c != b'-')
        .map(|c| c.to_ascii_uppercase())
        .collect();
    if v.len() != 9 || !v[..8].iter().all(u8::is_ascii_digit) || !v[8].is_ascii_uppercase() {
        return false;
    }
    let n: u64 = v[..8].iter().fold(0, |a, &c| a * 10 + u64::from(c - b'0'));
    DNI_LETTERS[(n % 23) as usize] == v[8]
}

/// NIE: X, Y or Z, 7 digits and the check letter (X, Y, Z count as 0, 1, 2).
fn nie_valid(raw: &str) -> bool {
    let v: Vec<u8> = raw
        .bytes()
        .filter(|&c| c != b'-')
        .map(|c| c.to_ascii_uppercase())
        .collect();
    if v.len() != 9 || !v[1..8].iter().all(u8::is_ascii_digit) || !v[8].is_ascii_uppercase() {
        return false;
    }
    let Some(lead) = b"XYZ".iter().position(|&c| c == v[0]) else {
        return false;
    };
    let n: u64 = v[1..8]
        .iter()
        .fold(lead as u64, |a, &c| a * 10 + u64::from(c - b'0'));
    DNI_LETTERS[(n % 23) as usize] == v[8]
}

/// A public IPv4 address: loopback, private, link-local, shared, documentation and reserved
/// ranges are left alone (the Node.js rule).
fn ipv4_public(raw: &str) -> bool {
    let parts: Vec<u32> = raw
        .split('.')
        .map(|p| p.parse::<u32>().unwrap_or(u32::MAX))
        .collect();
    if parts.len() != 4 || parts.iter().any(|&p| p > 255) {
        return false;
    }
    let (a, b) = (parts[0], parts[1]);
    !(a == 0
        || a == 10
        || a == 127
        || a >= 224
        || (a == 169 && b == 254)
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && b == 168)
        || (a == 100 && (64..=127).contains(&b))
        || (a == 192 && b == 0)
        || (a == 198 && (b == 18 || b == 19 || b == 51))
        || (a == 203 && b == 0))
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

/// ASCII letter or digit (the Node.js lookarounds of these types are ASCII-only).
fn ascii_alnum(c: Option<char>) -> bool {
    c.is_some_and(|c| c.is_ascii_alphanumeric())
}

/// A lookbehind or a lookahead: `true` when the character next to the match is allowed.
type Around = fn(Option<char>) -> bool;

fn not_alnum(c: Option<char>) -> bool {
    !ascii_alnum(c)
}

fn dni_before(c: Option<char>) -> bool {
    !matches!(c, Some(c) if c.is_ascii_alphanumeric() || "_.-".contains(c))
}

fn dni_after(c: Option<char>) -> bool {
    !matches!(c, Some(c) if c.is_ascii_alphanumeric() || c == '_')
}

fn not_digit_or_dot(c: Option<char>) -> bool {
    !matches!(c, Some(c) if c.is_ascii_digit() || c == '.')
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
    let mut last_end = None;
    while pos < text.len() {
        let Some(m) = re.find_at(text, pos) else {
            break;
        };
        let (s, e) = (m.start(), m.end());
        // A `+` that starts right where a redacted number ended starts a new number
        // ("+14155552671+14155552671"): judge it as if nothing came before it, so one pass
        // redacts both and a second pass finds nothing.
        let adjacent = last_end == Some(s) && text.as_bytes()[s] == b'+';
        let found = (s + 1..=e)
            .rev()
            .filter(|&end| text.as_bytes()[end - 1].is_ascii_digit())
            .find(|&end| {
                let ok = if adjacent {
                    bound(&text[s..], 0, end - s)
                } else {
                    bound(text, s, end)
                };
                ok && valid(&text[s..end])
            });
        match found {
            Some(end) => {
                spans.push((s, end));
                last_end = Some(end);
                pos = end;
            }
            None => pos = e,
        }
    }
    spans
}

/// Spans of `pat` found as a JavaScript global regex with a lookbehind and a lookahead finds
/// them (the Node.js scrubber's way): a start that fails its lookbehind is skipped, a match whose
/// lookahead fails gives way to a shorter one (the longest end that passes), the next search
/// starts where the match ended, and the match is kept only if `valid` accepts it. The
/// anchored half of `pat` tests the shorter ends.
fn js_spans(
    pat: &(Regex, Regex),
    text: &str,
    before: Around,
    after: Around,
    valid: Check,
) -> Vec<(usize, usize)> {
    let mut spans = Vec::new();
    let mut pos = 0;
    while pos < text.len() {
        let Some(m) = pat.0.find_at(text, pos) else {
            break;
        };
        let (s, e) = (m.start(), m.end());
        let step = s + char_after(text, s).map_or(1, char::len_utf8);
        if !before(char_before(text, s)) {
            pos = step;
            continue;
        }
        let end = (s + 1..=e).rev().find(|&x| {
            text.is_char_boundary(x)
                && after(char_after(text, x))
                && (x == e || pat.1.is_match(&text[s..x]))
        });
        match end {
            Some(x) => {
                if valid(&text[s..x]) {
                    spans.push((s, x));
                }
                pos = x;
            }
            None => pos = step,
        }
    }
    spans
}

/// Redaction spans of the PII types, as `(start, end, marker)`.
type Marked = (usize, usize, &'static str);

/// Overlapping spans form a cluster that is redacted once, as the Node.js scrubber does
/// (`resolveOverlaps`): spans that cover the whole cluster win; otherwise the longest span
/// (the earlier one on a tie) names the marker and the union is redacted.
fn resolve_overlaps(mut spans: Vec<Marked>) -> Vec<Marked> {
    spans.sort_by(|a, b| a.0.cmp(&b.0).then(b.1.cmp(&a.1)));
    let mut out = Vec::with_capacity(spans.len());
    let mut i = 0;
    while i < spans.len() {
        let start = spans[i].0;
        let mut end = spans[i].1;
        let mut j = i + 1;
        while j < spans.len() && spans[j].0 < end {
            end = end.max(spans[j].1);
            j += 1;
        }
        let members = &spans[i..j];
        let covering: Vec<&Marked> = members
            .iter()
            .filter(|m| m.0 == start && m.1 == end)
            .collect();
        let pool: Vec<&Marked> = if covering.is_empty() {
            members.iter().collect()
        } else {
            covering
        };
        let mut best = pool[0];
        for m in &pool {
            if m.1 - m.0 > best.1 - best.0 {
                best = m;
            }
        }
        out.push((start, end, best.2));
        i = j;
    }
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

fn iban_spans(text: &str) -> Vec<(usize, usize)> {
    js_spans(iban_re(), text, not_alnum, not_alnum, iban_valid)
}

fn dni_spans(text: &str) -> Vec<(usize, usize)> {
    js_spans(dni_re(), text, dni_before, dni_after, dni_valid)
}

fn nie_spans(text: &str) -> Vec<(usize, usize)> {
    js_spans(nie_re(), text, dni_before, dni_after, nie_valid)
}

fn ipv4_spans(text: &str) -> Vec<(usize, usize)> {
    js_spans(
        ipv4_re(),
        text,
        not_digit_or_dot,
        not_digit_or_dot,
        ipv4_public,
    )
}

/// A redaction of the text: bytes `[start, end)` become `repl`. `pri` is the Node.js layer
/// priority of what found it (1 = secret patterns, 2 = PII; lower wins).
struct Edit {
    start: usize,
    end: usize,
    repl: String,
    pri: u8,
}

/// A text being scrubbed in stages. When `origin` is kept, every byte also records the span of
/// the first text it stands for and whether a redaction wrote it, so the redactions can be
/// listed as edits of that first text afterwards.
struct Tracked {
    text: String,
    origin: Option<Origin>,
}

struct Origin {
    lo: Vec<usize>,
    hi: Vec<usize>,
    pri: Vec<u8>,
}

impl Tracked {
    fn new(text: &str, track: bool) -> Self {
        let origin = track.then(|| Origin {
            lo: (0..text.len()).collect(),
            hi: (1..=text.len()).collect(),
            pri: vec![0; text.len()],
        });
        Tracked {
            text: text.to_string(),
            origin,
        }
    }

    /// Replaces the given non-overlapping, ordered spans. A replacement equal to the text it
    /// replaces changes nothing.
    fn apply(&mut self, reps: Vec<(usize, usize, String)>, pri: u8) {
        let reps: Vec<_> = reps
            .into_iter()
            .filter(|(s, e, r)| self.text[*s..*e] != *r)
            .collect();
        if reps.is_empty() {
            return;
        }
        let mut out = String::with_capacity(self.text.len());
        let mut last = 0;
        let mut next = self.origin.as_ref().map(|_| Origin {
            lo: Vec::with_capacity(self.text.len()),
            hi: Vec::with_capacity(self.text.len()),
            pri: Vec::with_capacity(self.text.len()),
        });
        for (s, e, r) in &reps {
            out.push_str(&self.text[last..*s]);
            out.push_str(r);
            if let (Some(o), Some(n)) = (&self.origin, &mut next) {
                n.lo.extend_from_slice(&o.lo[last..*s]);
                n.hi.extend_from_slice(&o.hi[last..*s]);
                n.pri.extend_from_slice(&o.pri[last..*s]);
                n.lo.resize(n.lo.len() + r.len(), o.lo[*s]);
                n.hi.resize(n.hi.len() + r.len(), o.hi[*e - 1]);
                n.pri.resize(n.pri.len() + r.len(), pri);
            }
            last = *e;
        }
        out.push_str(&self.text[last..]);
        if let (Some(o), Some(n)) = (&self.origin, &mut next) {
            n.lo.extend_from_slice(&o.lo[last..]);
            n.hi.extend_from_slice(&o.hi[last..]);
            n.pri.extend_from_slice(&o.pri[last..]);
        }
        self.text = out;
        self.origin = next;
    }

    /// The redactions made so far, as edits of the first text.
    fn edits(&self) -> Vec<Edit> {
        let Some(o) = &self.origin else {
            return Vec::new();
        };
        let mut edits = Vec::new();
        let mut i = 0;
        while i < self.text.len() {
            if o.pri[i] == 0 {
                i += 1;
                continue;
            }
            let mut j = i + 1;
            while j < self.text.len() && o.pri[j] != 0 && o.lo[j] == o.lo[i] && o.hi[j] == o.hi[i] {
                j += 1;
            }
            edits.push(Edit {
                start: o.lo[i],
                end: o.hi[i],
                repl: self.text[i..j].to_string(),
                pri: o.pri[i],
            });
            i = j;
        }
        edits
    }
}

/// Overlapping edits form a cluster that is redacted once, as the Node.js scrubber does
/// (`resolveOverlaps`): an edit that covers the whole cluster wins (lowest priority number,
/// then the longest; the earlier one on a tie); otherwise the union is redacted with the
/// replacement of the best member.
fn resolve_edits(mut edits: Vec<Edit>) -> Vec<Edit> {
    edits.sort_by(|a, b| {
        a.start
            .cmp(&b.start)
            .then(b.end.cmp(&a.end))
            .then(a.pri.cmp(&b.pri))
    });
    let mut out = Vec::with_capacity(edits.len());
    let mut i = 0;
    while i < edits.len() {
        let start = edits[i].start;
        let mut end = edits[i].end;
        let mut j = i + 1;
        while j < edits.len() && edits[j].start < end {
            end = end.max(edits[j].end);
            j += 1;
        }
        let members = &edits[i..j];
        let covering = members.iter().any(|m| m.start == start && m.end == end);
        let mut best: Option<&Edit> = None;
        for m in members {
            if covering && !(m.start == start && m.end == end) {
                continue;
            }
            let better = best.is_none_or(|b| {
                m.pri < b.pri || (m.pri == b.pri && m.end - m.start > b.end - b.start)
            });
            if better {
                best = Some(m);
            }
        }
        if let Some(b) = best {
            out.push(Edit {
                start,
                end,
                repl: b.repl.clone(),
                pri: b.pri,
            });
        }
        i = j;
    }
    out
}

/// The scrubbing stages, in order of specificity, on one text.
fn scrub_stages(t: &mut Tracked, pii: &PiiOptions) {
    let jwt: Vec<_> = jwt_re()
        .find_iter(&t.text)
        .map(|m| (m.start(), m.end(), "[JWT_REDACTED]".to_string()))
        .collect();
    t.apply(jwt, 1);
    if pii.email {
        let emails: Vec<_> = email_re()
            .find_iter(&t.text)
            .map(|m| (m.start(), m.end(), "[EMAIL_REDACTED]".to_string()))
            .collect();
        t.apply(emails, 2);
    }
    let auth: Vec<_> = auth_re()
        .captures_iter(&t.text)
        .map(|c| {
            (
                c.get(0).map_or(0, |m| m.start()),
                c.get(0).map_or(0, |m| m.end()),
                redact_auth(&c),
            )
        })
        .collect();
    t.apply(auth, 1);
    let api: Vec<_> = api_re()
        .captures_iter(&t.text)
        .map(|c| {
            (
                c.get(0).map_or(0, |m| m.start()),
                c.get(0).map_or(0, |m| m.end()),
                redact_secret(&c),
            )
        })
        .collect();
    t.apply(api, 1);
    // The PII types are all searched in the same text, and spans that overlap are
    // resolved together (a keyed value that is also an IBAN, a DNI or an IP address).
    let output = &t.text;
    let mut found: Vec<Marked> = Vec::new();
    let mut add = |spans: Vec<(usize, usize)>, marker: &'static str| {
        found.extend(spans.into_iter().map(|(s, e)| (s, e, marker)));
    };
    if pii.phone {
        add(e164_spans(output), "[PHONE_REDACTED]");
        add(nanp_spans(output), "[PHONE_REDACTED]");
    }
    if pii.iban {
        add(iban_spans(output), "[IBAN_REDACTED]");
    }
    if pii.card {
        add(card_spans(output), "[CARD_REDACTED]");
    }
    if pii.dni {
        add(dni_spans(output), "[DNI_REDACTED]");
        add(nie_spans(output), "[NIE_REDACTED]");
    }
    if pii.ssn {
        add(ssn_spans(output), "[SSN_REDACTED]");
    }
    if pii.ipv4 {
        add(ipv4_spans(output), "[IPV4_REDACTED]");
    }
    if pii.name {
        add(keyed::person_name_spans(output), "[PERSON_NAME_REDACTED]");
    }
    if pii.address {
        add(keyed::address_spans(output), "[POSTAL_ADDRESS_REDACTED]");
    }
    if pii.username {
        add(keyed::username_spans(output), "[USERNAME_REDACTED]");
    }
    if !found.is_empty() {
        let reps = resolve_overlaps(found)
            .into_iter()
            .map(|(s, e, m)| (s, e, m.to_string()))
            .collect();
        t.apply(reps, 2);
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
        Self::scrub_with(input, &PiiOptions::default())
    }

    /// Like [`Scrubber::scrub`], with the PII types to redact chosen by `pii`
    /// (secrets, JWTs and Authorization headers are always redacted).
    pub fn scrub_with(input: &str, pii: &PiiOptions) -> String {
        // Invisible characters and wrapped line breaks can split a value. The text is scrubbed as
        // it is and, as a second view, without them; the second view's redactions are mapped
        // back to the original text and the union is resolved as one set of edits. A text with
        // neither is scrubbed once, as it is.
        let Some(view) = invisible::view(input) else {
            let mut plain = Tracked::new(input, false);
            scrub_stages(&mut plain, pii);
            return plain.text;
        };
        let mut direct = Tracked::new(input, true);
        scrub_stages(&mut direct, pii);
        let mut via_view = Tracked::new(&view.clean, true);
        scrub_stages(&mut via_view, pii);
        let mut edits = direct.edits();
        let direct_count = edits.len();
        for e in via_view.edits() {
            let (start, end) = view.original_span(e.start, e.end);
            edits.push(Edit { start, end, ..e });
        }
        if edits.len() == direct_count {
            return direct.text;
        }
        let edits = resolve_edits(edits);
        let mut output = String::with_capacity(input.len());
        let mut last = 0;
        for e in &edits {
            output.push_str(&input[last..e.start]);
            output.push_str(&e.repl);
            last = e.end;
        }
        output.push_str(&input[last..]);
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

    /// Like [`Scrubber::contains_pii`], with the PII types chosen by `pii`.
    pub fn contains_pii_with(input: &str, pii: &PiiOptions) -> bool {
        Self::scrub_with(input, pii) != input
    }

    /// Get a list of PII types found in the input
    ///
    /// # Returns
    /// A vector of PII type names found in the input
    pub fn detect_pii_types(input: &str) -> Vec<&'static str> {
        Self::detect_pii_types_with(input, &PiiOptions::default())
    }

    /// Like [`Scrubber::detect_pii_types`], for the PII types chosen by `pii`.
    pub fn detect_pii_types_with(input: &str, pii: &PiiOptions) -> Vec<&'static str> {
        let mut types = Vec::new();

        if pii.email && email_re().is_match(input) {
            types.push("email");
        }
        if api_re().is_match(input) {
            types.push("api_key_or_secret");
        }
        if pii.iban && !iban_spans(input).is_empty() {
            types.push("iban");
        }
        if pii.card && !card_spans(input).is_empty() {
            types.push("credit_card");
        }
        if pii.dni && (!dni_spans(input).is_empty() || !nie_spans(input).is_empty()) {
            types.push("dni");
        }
        if pii.ssn && !ssn_spans(input).is_empty() {
            types.push("ssn");
        }
        if pii.phone && (!e164_spans(input).is_empty() || !nanp_spans(input).is_empty()) {
            types.push("phone");
        }
        if pii.ipv4 && !ipv4_spans(input).is_empty() {
            types.push("ipv4");
        }
        if pii.name && !keyed::person_name_spans(input).is_empty() {
            types.push("name");
        }
        if pii.address && !keyed::address_spans(input).is_empty() {
            types.push("address");
        }
        if pii.username && !keyed::username_spans(input).is_empty() {
            types.push("username");
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
    fn test_scrub_json_member() {
        // Fake, random-looking values only.
        let v = "zn_FAKEabcdef0123456789abcdef";
        for input in [
            format!(r#"{{"api_key":"{v}"}}"#),
            format!(r#"{{"api_key" : "{v}"}}"#),
            format!(r#"{{"api_key": "{v}"}}"#),
            format!(r#"{{"password":"{v}","x":1}}"#),
            format!("{{'api_key': '{v}'}}"),
            format!(r#"{{"token": {v}}}"#),
            format!(r#"{{"body":"{{\"api_key\":\"{v}\"}}"}}"#),
        ] {
            let scrubbed = Scrubber::scrub(&input);
            assert!(
                scrubbed.contains("[SECRET_REDACTED]"),
                "{input} -> {scrubbed}"
            );
            assert!(!scrubbed.contains(v), "{input} -> {scrubbed}");
            assert!(Scrubber::contains_pii(&input), "{input}");
        }
        // The quotes stay, so a redacted JSON object is still JSON.
        assert_eq!(
            Scrubber::scrub(&format!(r#"{{"api_key":"{v}","n":1}}"#)),
            r#"{"api_key": "[SECRET_REDACTED]","n":1}"#
        );
        // Plain assignments keep their old output.
        assert_eq!(
            Scrubber::scrub(&format!("api_key=\"{v}\"")),
            "api_key: [SECRET_REDACTED]"
        );
    }

    #[test]
    fn test_json_member_negatives() {
        // A name that is not in the list, and a value under the 8-character minimum.
        for input in [
            r#"{"color":"zn_FAKEabcdef0123456789abcdef"}"#,
            r#"{"api_key":"abc123"}"#,
            r#"{"api_key": ""}"#,
            r#"{"api_key_count": 3}"#,
        ] {
            assert_eq!(Scrubber::scrub(input), input);
            assert!(!Scrubber::contains_pii(input), "{input}");
        }
    }

    #[test]
    fn test_scrub_escaped_quotes_in_json_string() {
        // A shell command inside a JSON string: the quotes around the value are escaped.
        let v = "zn_FAKEabcdef0123456789abcdef";
        let input = format!(r#"{{"command":"export api_key=\"{v}\" && run"}}"#);
        let out = Scrubber::scrub(&input);
        assert!(!out.contains(v), "{out}");
        assert_eq!(
            out,
            r#"{"command":"export api_key: [SECRET_REDACTED] && run"}"#
        );
        let input = format!(r#"{{"command":"curl -d password=\"{v}\""}}"#);
        assert!(!Scrubber::scrub(&input).contains(v));
    }

    #[test]
    fn test_scrub_authorization_header() {
        // Fake, random-looking tokens only.
        let t = "Zk8Qw3Lm9Xv2Rt7Yp4Nb";
        for input in [
            format!("Authorization: Bearer {t}"),
            format!("curl -H \"Authorization: Bearer {t}\" https://example.com/"),
            format!("authorization:bearer {t}"),
            format!(r#"{{"Authorization":"Bearer {t}"}}"#),
            format!(r#"{{"cmd":"curl -H \"Authorization: Bearer {t}\""}}"#),
            "Authorization: Basic dXNlcjpwYXNzd29yZDEyMw==".to_string(),
            format!("Proxy-Authorization: Bearer {t}"),
        ] {
            let out = Scrubber::scrub(&input);
            assert!(out.contains("[SECRET_REDACTED]"), "{input} -> {out}");
            assert!(
                !out.contains(t) && !out.contains("dXNlcjpwYXNzd29yZDEyMw"),
                "{input} -> {out}"
            );
        }
        assert_eq!(
            Scrubber::scrub(&format!("Authorization: Bearer {t}.")),
            "Authorization: Bearer [SECRET_REDACTED]."
        );
        // Stable on a second pass.
        let once = Scrubber::scrub(&format!("Authorization: Bearer {t}"));
        assert_eq!(Scrubber::scrub(&once), once);
    }

    #[test]
    fn test_authorization_header_negatives() {
        // Placeholders, references, short values and words are not credentials.
        for input in [
            "Authorization: Bearer token",
            "Authorization: Bearer your_token_here",
            "Authorization: Bearer ${API_TOKEN}",
            "Authorization: Bearer $TOKEN_VALUE",
            "Authorization: Bearer <token>",
            "Authorization: Bearer abcdefghijkl",
            "Authorization: Bearer xxxxxxxxxxxx",
            "Authorization: Bearer process.env.AUTH_TOKEN_X",
            "Bearer tokens expire after an hour",
        ] {
            assert_eq!(Scrubber::scrub(input), input);
        }
    }

    #[test]
    fn test_scrub_shell_split_value() {
        // The shell joins 'a''b' and a""b into one word, so no half may stay readable.
        for input in [
            "api_key='fakeSecret''Value1234'",
            "api_key=fakeSecret\"\"Value1234",
            "api_key=\"fakeSecret\"\"Value1234\"",
            "api_key='fakeSecret'\"Value1234\"'Tail5678'",
            "export api_key=fakeSecret''Value1234 && run",
        ] {
            let out = Scrubber::scrub(input);
            assert!(
                !out.contains("Value1234") && !out.contains("fakeSecret"),
                "{input} -> {out}"
            );
            assert!(!out.contains("Tail5678"), "{input} -> {out}");
            assert!(out.contains("[SECRET_REDACTED]"), "{input} -> {out}");
            assert_eq!(Scrubber::scrub(&out), out);
        }
        assert_eq!(
            Scrubber::scrub("export api_key=fakeSecret''Value1234 && run"),
            "export api_key: [SECRET_REDACTED] && run"
        );
        // A quoted value followed by other words or members is untouched.
        assert_eq!(
            Scrubber::scrub(r#"api_key="fakeSecret1" "other""#),
            r#"api_key: [SECRET_REDACTED] "other""#
        );
        assert_eq!(
            Scrubber::scrub(r#"{"api_key":"fakeSecret1","n":"v"}"#),
            r#"{"api_key": "[SECRET_REDACTED]","n":"v"}"#
        );
    }

    #[test]
    fn test_adjacent_phone_numbers_are_redacted_in_one_pass() {
        // Same case as the idempotence test of the scrubber fuzz target (B-1013).
        let once = Scrubber::scrub("+14155552671+14155552671");
        assert_eq!(once, "[PHONE_REDACTED][PHONE_REDACTED]");
        assert_eq!(Scrubber::scrub(&once), once);
        assert_eq!(
            Scrubber::scrub("+14155552671+14155552671+14155552671"),
            "[PHONE_REDACTED][PHONE_REDACTED][PHONE_REDACTED]"
        );
        // Separated numbers were already stable; a number glued to letters stays alone.
        for input in ["+14155552671 +14155552671", "+14155552671,+14155552671"] {
            let once = Scrubber::scrub(input);
            assert_eq!(once, input.replace("+14155552671", "[PHONE_REDACTED]"));
            assert_eq!(Scrubber::scrub(&once), once);
        }
        assert_eq!(Scrubber::scrub("a+14155552671"), "a+14155552671");
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

#[cfg(test)]
mod invisible_tests;
#[cfg(test)]
mod parity_tests;

#[cfg(test)]
mod options_tests {
    use super::*;

    #[test]
    fn defaults_match_the_node_scrubber() {
        let d = PiiOptions::default();
        assert!(d.email && d.phone && d.iban && d.card && d.dni && d.ssn);
        assert!(d.name && d.address && d.username);
        assert!(!d.ipv4, "IPv4 is off by default, as in Node");
    }

    #[test]
    fn ipv4_switch_redacts_public_addresses_only() {
        let on = PiiOptions {
            ipv4: true,
            ..PiiOptions::default()
        };
        assert_eq!(
            Scrubber::scrub_with("host 8.8.8.8 up", &on),
            "host [IPV4_REDACTED] up"
        );
        assert_eq!(Scrubber::scrub_with("v1.2.3.4", &on), "v[IPV4_REDACTED]");
        for input in [
            "10.0.0.1",
            "172.16.5.4",
            "192.168.1.1",
            "127.0.0.1",
            "169.254.1.1",
            "100.64.0.1",
            "0.1.2.3",
            "224.0.0.1",
            "192.0.2.10",   // documentation range
            "198.51.100.7", // documentation range
            "203.0.113.9",  // documentation range
            "256.1.1.1",
            "1.2.3.456",
            "1.2.3",
            "1.2.3.4.5",
        ] {
            assert_eq!(Scrubber::scrub_with(input, &on), input, "{input}");
        }
    }

    #[test]
    fn each_type_can_be_switched_off() {
        let all = [
            "a@example.com",
            "4111111111111111",
            "GB82WEST12345698765432",
            "12345678Z",
            "078-05-1120",
            "+442071838750",
            "X-User-Name: Jane Example",
            "X-Address: 1 Example Street",
            "X-Username: jane_example",
        ]
        .join(
            "
",
        );
        let all = all.as_str();
        let none = PiiOptions::none();
        // Nothing but PII in the text, so nothing is redacted.
        assert_eq!(Scrubber::scrub_with(all, &none), all);
        assert!(!Scrubber::contains_pii_with(all, &none));
        let one = |f: fn(&mut PiiOptions), marker: &str| {
            let mut o = PiiOptions::none();
            f(&mut o);
            let out = Scrubber::scrub_with(all, &o);
            assert_eq!(out.matches("_REDACTED]").count(), 1, "{marker}: {out}");
            assert!(out.contains(marker), "{marker}: {out}");
        };
        one(|o| o.email = true, "[EMAIL_REDACTED]");
        one(|o| o.iban = true, "[IBAN_REDACTED]");
        one(|o| o.card = true, "[CARD_REDACTED]");
        one(|o| o.dni = true, "[DNI_REDACTED]");
        one(|o| o.ssn = true, "[SSN_REDACTED]");
        one(|o| o.phone = true, "[PHONE_REDACTED]");
        one(|o| o.name = true, "[PERSON_NAME_REDACTED]");
        one(|o| o.address = true, "[POSTAL_ADDRESS_REDACTED]");
        one(|o| o.username = true, "[USERNAME_REDACTED]");
        // The defaults redact every one of them.
        assert_eq!(Scrubber::scrub(all).matches("_REDACTED]").count(), 9);
    }

    #[test]
    fn secrets_are_redacted_whatever_the_pii_options() {
        let input = "api_key=fakekeyfakekeyfakekey";
        assert!(Scrubber::scrub_with(input, &PiiOptions::none()).contains("[SECRET_REDACTED]"));
    }

    #[test]
    fn detect_pii_types_names_the_new_types() {
        let input = [
            "GB82WEST12345698765432 12345678Z",
            "X-User-Name: Jane Example",
            "X-Address: 1 Example Street",
            "X-Username: jane_example",
            "8.8.8.8",
        ]
        .join(
            "
",
        );
        let input = input.as_str();
        let types = Scrubber::detect_pii_types(input);
        for t in ["iban", "dni", "name", "address", "username"] {
            assert!(types.contains(&t), "{t} in {types:?}");
        }
        assert!(!types.contains(&"ipv4"), "{types:?}");
        let on = PiiOptions {
            ipv4: true,
            ..PiiOptions::default()
        };
        assert!(Scrubber::detect_pii_types_with(input, &on).contains(&"ipv4"));
        assert!(Scrubber::detect_pii_types_with(input, &PiiOptions::none()).is_empty());
    }

    #[test]
    fn validators_match_node() {
        assert!(iban_valid("GB82 WEST 1234 5698 7654 32"));
        assert!(!iban_valid("GB82WEST12345698765433"));
        assert!(!iban_valid("XX82WEST12345698765432"));
        assert!(dni_valid("12345678-Z"));
        assert!(!dni_valid("12345678A"));
        assert!(nie_valid("X1234567L"));
        assert!(!nie_valid("X1234567A"));
        assert!(ipv4_public("8.8.8.8"));
        assert!(!ipv4_public("192.168.1.1"));
    }
}
