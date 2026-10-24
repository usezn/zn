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
static AUTH_HEADER_REGEX: OnceLock<Regex> = OnceLock::new();
static AUTH_PLACEHOLDER_REGEX: OnceLock<Regex> = OnceLock::new();
static QUOTED_OPEN_REGEX: OnceLock<Regex> = OnceLock::new();

fn email_re() -> &'static Regex {
    EMAIL_REGEX
        .get_or_init(|| Regex::new(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}").unwrap())
}

fn api_re() -> &'static Regex {
    API_KEY_REGEX.get_or_init(|| {
        // Matches: api_key=xxx, secret: xxx, password=xxx, token: xxx, and the same as a JSON
        // member ("api_key": "xxx"), also inside a JSON string (\"api_key\":\"xxx\").
        // Group 1 is the name, group 2 the optional quote that closes it. A quoted value needs
        // its closing quote, of the same kind AND at the same escape level as the one that
        // opens it, like the Node scrubber (the regex crate has no backreferences, so there is
        // one alternative per level: `"v"`, `\"v\"`, `\\"v\\"`, and the same with `'`).
        // The value may have any character but that quote, a backslash or a space (`/`, `+`,
        // `=`, `@`, the other quote...); an unescaped double-quoted value may also have an
        // escaped quote or backslash (`"ab\"cd"`). Groups (quote, value): 3-4 `"`, 5-6 `\"`,
        // 7-8 `\\"`, 9-10 `'`, 11-12 `\'`, 13-14 `\\'`. A value that opens with an escaped
        // quote and has no closing quote of its own is inside a JSON string that ends right
        // after it: it is redacted up to there and what follows is kept (groups 15-16 and
        // 17-18). Without a closing quote an unescaped value is not redacted, so a JSON string
        // is never left half closed. An unquoted value (group 19) is a run of token characters.
        // Requires at least 8 characters for the value (reduced from 16 for better detection).
        // A value split by shell quotes ('ab''cd', ab""cd) is one word: redact all of it. Each
        // extra piece needs a character after its quote, so the quote that closes a JSON string
        // (`?token=abc"}`, `["token=abc","x"]`) is never taken.
        Regex::new(r#"(?i)(api[_-]?key|secret[_-]?key|password|token|auth[_-]?token|access[_-]?token|bearer)(\\{0,2}['"])?[ \t]*[:=][ \t]*(?:(")((?:[^"\\\s]|\\["\\]){8,})"|(\\")([^"\\\s]{8,})\\"|(\\\\")([^"\\\s]{8,})\\\\"|(')([^'\\\s]{8,})'|(\\')([^'\\\s]{8,})\\'|(\\\\')([^'\\\s]{8,})\\\\'|(\\")([^"\\\s]{8,})|(\\\\")([^"\\\s]{8,})|([a-zA-Z0-9_\-./+=]{8,}))(?:['"]+[a-zA-Z0-9_\-.]+)*"#).unwrap()
    })
}

/// `Authorization: Bearer <token>` (also Basic and Token, quoted, escaped or in a JSON member).
/// Group 1 is the header up to the token, group 2 the token (8 characters or more, no upper
/// bound). It is not the same rule as the Node scrubber's: Rust also takes Basic, Token and
/// Proxy-Authorization, and a token of 8 to 19 characters if it has a digit.
fn auth_re() -> &'static Regex {
    AUTH_HEADER_REGEX.get_or_init(|| {
        Regex::new(r#"(?i)((?:proxy-)?authorization(?:\\{0,2}['"])?[ \t]*[:=][ \t]*(?:\\{0,2}['"])?(?:bearer|basic|token)[ \t]+)([A-Za-z0-9._~+/=-]{8,})"#).unwrap()
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

/// The (quote, value) capture groups of the quoted alternatives of api_re(), and whether the
/// alternative has a closing quote of its own.
const QUOTED_VALUE_GROUPS: [(usize, usize, bool); 8] = [
    (3, 4, true),
    (5, 6, true),
    (7, 8, true),
    (9, 10, true),
    (11, 12, true),
    (13, 14, true),
    (15, 16, false),
    (17, 18, false),
];

/// The value of one api_re() match, without its quotes.
fn secret_value<'a>(caps: &regex::Captures<'a>) -> &'a str {
    QUOTED_VALUE_GROUPS
        .iter()
        .find_map(|&(_, v, _)| caps.get(v))
        .or_else(|| caps.get(19))
        .map_or("", |m| m.as_str())
}

/// A placeholder or a reference, not a credential: `${API_TOKEN}`, `$API_TOKEN`,
/// `<your-api-key>`, `********`, `xxxxxxxx`, `process.env.TOKEN`, `your_token_here`.
fn secret_placeholder(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    value.starts_with("${")
        || (value.starts_with('$')
            && value.len() > 1
            && value[1..]
                .bytes()
                .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_'))
        || (value.starts_with('<') && value.ends_with('>'))
        || value
            .bytes()
            .all(|b| matches!(b, b'*' | b'x' | b'X' | b'.' | b'-' | b'_' | b'='))
        || [
            "process.env",
            "os.environ",
            "os.getenv",
            "env.",
            "secrets.",
            "vars.",
            "config.",
            "settings.",
            "self.",
            "this.",
            "arn:",
        ]
        .iter()
        .any(|p| lower.starts_with(p))
        || [
            "your",
            "insert",
            "paste",
            "redacted",
            "changeme",
            "placeholder",
        ]
        .iter()
        .any(|p| {
            lower.starts_with(p)
                && lower
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || matches!(b, b'-' | b'_'))
        })
}

/// Longest quoted value (in bytes) the scanner of `redact_quoted_values` reads. A value with
/// no closing quote inside this window is left to api_re(), so the work per opening quote is
/// bounded and a long run of openers stays linear.
const MAX_QUOTED_VALUE: usize = 4096;

/// A secret name followed by `:` or `=` and an opening quote: groups 1 (name), 2 (the quote
/// that closes a quoted name) and 3 (the opening quote of the value, with the backslashes of a
/// JSON string inside a JSON string).
fn quoted_open_re() -> &'static Regex {
    QUOTED_OPEN_REGEX.get_or_init(|| {
        Regex::new(r#"(?i)(api[_-]?key|secret[_-]?key|password|token|auth[_-]?token|access[_-]?token|bearer)(\\{0,2}['"])?[ \t]*[:=][ \t]*(\\{0,2}["'])"#).unwrap()
    })
}

/// Redacts a quoted value of a secret name up to its closing quote, spaces included
/// (`"password":"abcdefgh ijk lmn"`). A double-quoted value ends at the first quote that is
/// not escaped (a backslash escapes the next character); a single-quoted one at the next `'`.
/// The closing quote is kept, so a JSON string stays valid. It only takes a value that has
/// whitespace in it (api_re() does the rest); a value shorter than 8 characters, a placeholder,
/// or one with no closing quote within MAX_QUOTED_VALUE bytes is left as it is (api_re() still
/// sees it afterwards).
fn redact_quoted_values(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut done = 0; // bytes of `text` already copied or replaced
    let mut from = 0; // where to look for the next opening
    while let Some(caps) = quoted_open_re().captures_at(text, from) {
        let whole = caps.get(0).unwrap();
        let quote = bytes[whole.end() - 1];
        let level = caps[3].len() - 1; // backslashes before the opening quote
        let start = whole.end();
        let limit = (start + MAX_QUOTED_VALUE).min(bytes.len());
        let mut i = start;
        let mut close = None; // (end of the value, end of the closing quote)
        while i < limit {
            if bytes[i] == b'\\' {
                if level > 0 {
                    // Escaped level: the value ends at exactly `level` backslashes and the quote.
                    // Count the run only inside the scan window, so one opener followed by a
                    // very long run of backslashes stays linear.
                    let mut k = 0;
                    while i + k < limit && bytes[i + k] == b'\\' {
                        k += 1;
                    }
                    if k == level && bytes.get(i + k) == Some(&quote) {
                        close = Some((i, i + k + 1));
                        break;
                    }
                    i += k + 1;
                } else if quote == b'"' {
                    i += 2; // a backslash escapes the next character
                } else {
                    i += 1;
                }
            } else if level == 0 && bytes[i] == quote {
                close = Some((i, i + 1));
                break;
            } else {
                i += 1;
            }
        }
        let Some((end, after)) = close else {
            from = whole.end();
            continue;
        };
        let value = &text[start..end];
        if value.chars().count() < 8
            || !value.contains(char::is_whitespace)
            || secret_placeholder(value)
        {
            from = whole.end();
            continue;
        }
        // A value glued to more quoted pieces ('a b''c') is one shell word: take them too.
        let mut after = after;
        if level == 0 {
            while matches!(bytes.get(after), Some(b'"' | b'\''))
                && !text[after..].trim_start_matches(['"', '\'']).is_empty()
            {
                let rest = text[after..].trim_start_matches(['"', '\'']);
                let piece = rest
                    .bytes()
                    .take_while(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
                    .count();
                if piece == 0 {
                    break;
                }
                after = text.len() - rest.len() + piece;
            }
        }
        out.push_str(&text[done..whole.start()]);
        out.push_str(&caps[1]);
        match caps.get(2) {
            None => out.push_str(": [SECRET_REDACTED]"),
            Some(key_quote) => {
                let open = &caps[3];
                out.push_str(&format!(
                    "{}: {open}[SECRET_REDACTED]{open}",
                    key_quote.as_str()
                ));
            }
        }
        done = after;
        from = done;
    }
    out.push_str(&text[done..]);
    out
}

/// Replacement for one api_re() match. A plain `name=value` becomes `name: [SECRET_REDACTED]`.
/// A quoted name (a JSON member) keeps its quotes, so the output is still valid JSON: an
/// unquoted value there (a number such as `12345678`) becomes a string, quoted like the name.
/// A placeholder or reference is left as it is.
fn redact_secret(caps: &regex::Captures) -> String {
    if secret_placeholder(secret_value(caps)) {
        return caps[0].to_string();
    }
    let name = &caps[1];
    match caps.get(2) {
        None => format!("{name}: [SECRET_REDACTED]"),
        Some(key_quote) => {
            let (open, close) = QUOTED_VALUE_GROUPS
                .iter()
                .find_map(|&(q, _, closed)| {
                    caps.get(q)
                        .map(|m| (m.as_str(), if closed { m.as_str() } else { "" }))
                })
                .unwrap_or_else(|| (key_quote.as_str(), key_quote.as_str()));
            format!(
                "{name}{}: {open}[SECRET_REDACTED]{close}",
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
    let mut last_end = None;
    while pos < text.len() {
        let Some(m) = re.find_at(text, pos) else {
            break;
        };
        let (s, e) = (m.start(), m.end());
        // A `+` that starts right where a redacted number ended starts a new number
        // ("+14155552671+14155552671"): judge its leading boundary as if nothing came before
        // it, so one pass redacts both and a second pass finds nothing.
        let adjacent = last_end == Some(s) && text.as_bytes()[s] == b'+';
        let lead_ok = adjacent || lead(text, s);
        let found = if lead_ok {
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
                last_end = Some(end);
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
        output = auth_re().replace_all(&output, redact_auth).to_string();
        output = redact_quoted_values(&output);
        output = api_re().replace_all(&output, redact_secret).to_string();
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
        if api_re()
            .captures_iter(input)
            .any(|c| !secret_placeholder(secret_value(&c)))
            || redact_quoted_values(input) != input
        {
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
        // Same case as the idempotence test of the scrubber fuzz target.
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
    fn test_quoted_value_is_redacted_whole_and_json_stays_valid() {
        // Fake values with characters outside a plain token class: the whole value goes and the
        // output still parses as JSON.
        for value in [
            "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
            "fakeSecret+Value+1234+abcdef",
            "fakeSecretValue1234abcdefgh==",
            "fake.Secret@example.invalid!Value1234",
        ] {
            for key in ["api_key", "password", "token", "secret_key"] {
                let input = format!(r#"{{"{key}":"{value}","n":"v"}}"#);
                let out = Scrubber::scrub(&input);
                assert!(!out.contains(&value[4..]), "{input} -> {out}");
                assert_eq!(
                    out,
                    format!(r#"{{"{key}": "[SECRET_REDACTED]","n":"v"}}"#),
                    "{input}"
                );
                serde_json::from_str::<serde_json::Value>(&out).expect("valid JSON");
                assert_eq!(Scrubber::scrub(&out), out);
            }
            // Single quotes and an escaped JSON string.
            let out = Scrubber::scrub(&format!("{{'password': '{value}'}}"));
            assert_eq!(out, "{'password': '[SECRET_REDACTED]'}");
            let out = Scrubber::scrub(&format!(r#"{{"cmd":"x \"api_key\":\"{value}\" y"}}"#));
            assert!(!out.contains(&value[4..]), "{out}");
            serde_json::from_str::<serde_json::Value>(&out).expect("valid JSON");
        }
        // A JSON-RPC line with such a password stays a valid request after scrubbing.
        let line = r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"arguments":{"password":"a/b+c=d@fakeValue1234"}}}"#;
        let out = Scrubber::scrub(line);
        assert!(!out.contains("fakeValue1234"), "{out}");
        let v: serde_json::Value = serde_json::from_str(&out).expect("valid JSON");
        assert_eq!(v["method"], "tools/call");
    }

    #[test]
    fn test_secret_at_end_of_json_string_keeps_json_valid() {
        // The quote that closes the JSON string must stay, even when the value has `/`, `+`, `=`.
        let v = "Zk8Qw3Lm9Xv2/Rt7Yp4Nb+==";
        let w = "fakeSecret+Value+1234+abcdef";
        for (input, secret) in [
            (
                format!(r#"{{"command":"curl https://example.com?token={v}"}}"#),
                v,
            ),
            (format!(r#"["token={w}","x"]"#), w),
            (format!(r#"{{"a":"x token={w}","b":"y"}}"#), w),
            (format!(r#"{{"cmd":"run api_key={v}","n":1}}"#), v),
            (format!(r#"{{"cmd":"run password={v}\n"}}"#), v),
        ] {
            let out = Scrubber::scrub(&input);
            assert!(!out.contains(secret), "{input} -> {out}");
            assert!(out.contains("[SECRET_REDACTED]"), "{input} -> {out}");
            serde_json::from_str::<serde_json::Value>(&out)
                .unwrap_or_else(|e| panic!("{input} -> {out}: {e}"));
            assert_eq!(Scrubber::scrub(&out), out);
        }
        // A benign JSON string with `token=` in it stays valid JSON too.
        let out = Scrubber::scrub(r#"{"path":"/v1/token=refresh/endpoint"}"#);
        serde_json::from_str::<serde_json::Value>(&out).expect("valid JSON");
        // Shell-split pieces still go.
        let out = Scrubber::scrub(r#"{"cmd":"export api_key='fakeSecret''Value1234' && run"}"#);
        assert!(
            !out.contains("Value1234") && !out.contains("fakeSecret"),
            "{out}"
        );
    }

    #[test]
    fn test_quoted_value_needs_its_closing_quote() {
        // An apostrophe inside a double-quoted value is part of the value.
        let input = r#"{"password":"abcdefgh'xyz123","n":1}"#;
        let out = Scrubber::scrub(input);
        assert_eq!(out, r#"{"password": "[SECRET_REDACTED]","n":1}"#);
        serde_json::from_str::<serde_json::Value>(&out).expect("valid JSON");
        let out = Scrubber::scrub(r#"{'password': 'abcdefg"hij123'}"#);
        assert_eq!(out, r#"{'password': '[SECRET_REDACTED]'}"#);
        // A quoted value with spaces is redacted whole, up to its closing quote.
        let input = r#"{"password":"abcdefgh ijk lmn","n":1}"#;
        let out = Scrubber::scrub(input);
        assert_eq!(out, r#"{"password": "[SECRET_REDACTED]","n":1}"#);
        serde_json::from_str::<serde_json::Value>(&out).expect("valid JSON");
    }

    #[test]
    fn test_quoted_value_with_spaces_goes_to_the_closing_quote() {
        for (input, gone) in [
            (r#"{"password":"abcdefgh ijk lmn","n":1}"#, "ijk"),
            (r#"{"token":"fake one two three four","n":1}"#, "three"),
            (
                r#"{"api_key":"fake key \"with\" quotes and spaces","n":1}"#,
                "spaces",
            ),
            (r#"{"secret_key":"tab\there and more words"}"#, "words"),
            ("{'password': 'fake pass phrase here'}", "phrase"),
        ] {
            let out = Scrubber::scrub(input);
            assert!(!out.contains(gone), "{input} -> {out}");
            assert!(out.contains("[SECRET_REDACTED]"), "{input} -> {out}");
            if input.starts_with("{\"") {
                let v: serde_json::Value = serde_json::from_str(&out).expect("valid JSON");
                assert!(v.as_object().is_some());
            }
            assert_eq!(Scrubber::scrub(&out), out, "not idempotent: {input}");
        }
        // Shell forms keep what follows the closing quote.
        assert_eq!(
            Scrubber::scrub(r#"export password="fake pass phrase here" && run"#),
            "export password: [SECRET_REDACTED] && run"
        );
        assert_eq!(
            Scrubber::scrub(r#"export password='fake pass phrase here''more' && run"#),
            "export password: [SECRET_REDACTED]' && run"
        );
        // Short values, placeholders and an unterminated quote are not taken whole.
        for input in [
            r#"{"password":"a b c","n":1}"#,
            r#"{"token":"${API TOKEN HERE}"}"#,
        ] {
            assert_eq!(Scrubber::scrub(input), input);
        }
        // Past the cap the closing quote is not searched for; the work stays bounded.
        let long = format!(r#"{{"password":"{}"}}"#, "ab cd ".repeat(2000));
        let out = Scrubber::scrub(&long);
        assert_eq!(out.len(), long.len());
        let many = r#"password=""#.repeat(50_000);
        let start = std::time::Instant::now();
        let _ = Scrubber::scrub(&many);
        assert!(start.elapsed() < std::time::Duration::from_secs(5));
        assert!(
            Scrubber::detect_pii_types(r#"{"password":"abcdefgh ijk lmn"}"#)
                .contains(&"api_key_or_secret")
        );
    }

    #[test]
    fn test_review_repro_cases_stay_valid_json() {
        // The cases of the independent review (F5 and F6).
        for input in [
            r#"{"max_token":100000000,"x":1}"#,
            r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"t","arguments":{"page_token":123456789}}}"#,
            r#"{"password":"abcdefgh12","n":1}"#,
        ] {
            let out = Scrubber::scrub(input);
            serde_json::from_str::<serde_json::Value>(&out)
                .unwrap_or_else(|e| panic!("{input} -> {out}: {e}"));
            assert_ne!(out, input);
            assert!(
                !out.contains("12345678") && !out.contains("100000000"),
                "{out}"
            );
        }
    }

    #[test]
    fn test_unquoted_json_value_becomes_a_string() {
        let out = Scrubber::scrub(r#"{"token":12345678}"#);
        assert_eq!(out, r#"{"token": "[SECRET_REDACTED]"}"#);
        let out = Scrubber::scrub(r#"{'token': 12345678}"#);
        assert_eq!(out, r#"{'token': '[SECRET_REDACTED]'}"#);
    }

    /// Every secret value must be gone and the output must still parse as JSON.
    fn assert_valid_and_clean(input: &str, secrets: &[&str]) {
        serde_json::from_str::<serde_json::Value>(input).expect("valid input");
        let out = Scrubber::scrub(input);
        let v = serde_json::from_str::<serde_json::Value>(&out)
            .unwrap_or_else(|e| panic!("{input} -> {out}: {e}"));
        for secret in secrets {
            assert!(!out.contains(secret), "{input} -> {out}");
        }
        assert!(out.contains("[SECRET_REDACTED]"), "{input} -> {out}");
        assert_eq!(Scrubber::scrub(&out), out, "not idempotent: {input}");
        drop(v);
    }

    #[test]
    fn test_parse_after_scrub_matrix() {
        let keys = ["password", "token", "api_key", "secret_key", "access_token"];
        for key in keys {
            // numbers, spaced strings, escaped quotes, backslashes, unicode
            for (value_json, secret) in [
                ("12345678", "12345678"),
                ("1234567890123456", "1234567890123456"),
                ("-12345678.5", "12345678"),
                ("1.2345678e10", "2345678"),
                (r#""abcdefgh ijk lmn""#, "ijk"),
                (r#""fake \"quoted\" phrase""#, "phrase"),
                (r#""back\\slash value 12""#, "value"),
                (r#""tab\tand newline\nvalue""#, "newline"),
                (r#""caf\u00e9 phrase fake""#, "phrase"),
                (r#""fakeSecret+Value/1234==""#, "Value/1234"),
            ] {
                // alone, with neighbours before and after, nested and in an array
                for template in [
                    format!(r#"{{"{key}":{value_json}}}"#),
                    format!(r#"{{"a":1,"{key}":{value_json},"b":"x"}}"#),
                    format!(r#"{{"a":{{"b":{{"{key}":{value_json},"c":[1,2]}}}}}}"#),
                    format!(r#"[{{"{key}":{value_json}}},{{"{key}":{value_json}}}]"#),
                    format!(r#"{{"list":[true,null,{{"{key}":{value_json}}},"z"]}}"#),
                    format!(r#"{{ "{key}" : {value_json} , "n" : null }}"#),
                ] {
                    assert_valid_and_clean(&template, &[secret]);
                }
            }
        }
    }

    #[test]
    fn test_parse_after_scrub_booleans_null_and_plain_values() {
        // Not secrets: left alone, and still valid.
        for input in [
            r#"{"token":true}"#,
            r#"{"token":false,"password":null}"#,
            r#"{"api_key":null,"n":[true,false,null]}"#,
            r#"{"token":[1,2,3],"password":{"a":1}}"#,
            r#"{"nested":{"token":{"password":null}},"list":[null,true]}"#,
            r#"{"password":"short"}"#,
        ] {
            let out = Scrubber::scrub(input);
            serde_json::from_str::<serde_json::Value>(&out)
                .unwrap_or_else(|e| panic!("{input} -> {out}: {e}"));
            assert_eq!(out, input);
        }
        // Long literal words are never produced by the JSON grammar, but a number longer than
        // the minimum is a secret and becomes a string.
        assert_valid_and_clean(r#"{"n":null,"token":99999999,"ok":true}"#, &["99999999"]);
        // A secret in a JSON string value (shell form inside) still parses.
        assert_valid_and_clean(
            r#"{"command":"export password=\"fake pass phrase\" && run","n":1}"#,
            &["phrase"],
        );
        assert_valid_and_clean(
            r#"{"cmd":"export password=\"fake pass phrase\" ok","n":[true,null]}"#,
            &["phrase"],
        );
    }

    #[test]
    fn test_closing_quote_has_the_opening_escape_level() {
        // Each input is valid JSON. The quote that closes the value must be at the level of the
        // one that opens it, so the output parses, the whole secret is gone, and a second pass
        // changes nothing.
        let cases: [(&str, &[&str]); 4] = [
            (r#"{"password":"Abc12345!\"x"}"#, &["Abc12345", "x\""]),
            (r#"{"token":"abcdefghijk\"lmn"}"#, &["abcdefghijk", "lmn"]),
            (r#"{"a":"x \"token\":\"abcdefghijk"}"#, &["abcdefghijk"]),
            (r#"{"args":["--token=\"abcdefghijkl"]}"#, &["abcdefghijkl"]),
        ];
        for (input, secrets) in cases {
            serde_json::from_str::<serde_json::Value>(input).expect("valid input");
            let out = Scrubber::scrub(input);
            serde_json::from_str::<serde_json::Value>(&out)
                .unwrap_or_else(|e| panic!("{input} -> {out}: {e}"));
            assert!(out.contains("[SECRET_REDACTED]"), "{input} -> {out}");
            for secret in secrets {
                assert!(!out.contains(secret), "{input} -> {out}");
            }
            assert_eq!(Scrubber::scrub(&out), out, "not idempotent: {input}");
        }
        // The same members inside a JSON string, at the matching level, keep their close.
        let input = r#"{"a":"x \"token\":\"abcdefghijk\" y"}"#;
        let out = Scrubber::scrub(input);
        serde_json::from_str::<serde_json::Value>(&out).expect("valid JSON");
        assert!(!out.contains("abcdefghijk"), "{out}");
        // Two levels of escape (a JSON string inside a JSON string): not JSON itself, but the
        // quotes still match.
        let input = r#"{\\"token\\":\\"abcdefghijk\\"}"#;
        let out = Scrubber::scrub(input);
        assert_eq!(out, r#"{\\"token\\": \\"[SECRET_REDACTED]\\"}"#);
    }

    #[test]
    fn test_placeholders_in_json_member_are_left_alone() {
        for input in [
            r#"{"token": "${API_TOKEN}"}"#,
            r#"{"token": "$API_TOKEN"}"#,
            r#"{"api_key": "<your-api-key>"}"#,
            r#"{"password": "********"}"#,
            r#"{"password": "xxxxxxxxxx"}"#,
            r#"{"token":"<|endoftext|>"}"#,
            r#"{"token": "process.env.API_TOKEN"}"#,
            r#"{"api_key": "your_api_key_here"}"#,
            "token=process.env.API_TOKEN",
        ] {
            assert_eq!(Scrubber::scrub(input), input);
            assert!(!Scrubber::contains_pii(input), "{input}");
            assert!(
                !Scrubber::detect_pii_types(input).contains(&"api_key_or_secret"),
                "{input}"
            );
        }
        // A real-looking value next to a placeholder is still redacted.
        let out = Scrubber::scrub(r#"{"token":"${API_TOKEN}","password":"zn_FAKEabcdef0123"}"#);
        assert_eq!(
            out,
            r#"{"token":"${API_TOKEN}","password": "[SECRET_REDACTED]"}"#
        );
    }

    #[test]
    fn test_long_authorization_token_is_redacted_whole() {
        let token: String = (0..600)
            .map(|i| {
                char::from(
                    b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"[i % 62],
                )
            })
            .collect();
        let out = Scrubber::scrub(&format!("Authorization: Bearer {token}"));
        assert_eq!(out, "Authorization: Bearer [SECRET_REDACTED]");
        assert_eq!(Scrubber::scrub(&out), out);
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
    fn test_backslash_run_after_opener_stays_linear() {
        // One opener followed by a very long run of backslashes must cost about the same as the
        // same length of any other character: the run is counted only inside the scan window.
        let time = |input: &str| {
            (0..3)
                .map(|_| {
                    let start = std::time::Instant::now();
                    let _ = Scrubber::scrub(input);
                    start.elapsed()
                })
                .min()
                .unwrap()
        };
        for opener in ["password=\"", "password='", "password=\\\""] {
            let slashes = format!("{opener}{}", "\\".repeat(1 << 20));
            let filler = format!("{opener}{}", "a".repeat(1 << 20));
            let t_slashes = time(&slashes);
            let t_filler = time(&filler);
            eprintln!("{opener}: backslashes {t_slashes:?} filler {t_filler:?}");
            // Relative bound, with a small floor against timer noise on a fast filler run.
            let bound = t_filler * 10 + std::time::Duration::from_millis(200);
            assert!(
                t_slashes < bound,
                "{opener}: backslashes {t_slashes:?} vs filler {t_filler:?}"
            );
            assert!(t_slashes < std::time::Duration::from_secs(60), "{opener}");
        }
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
