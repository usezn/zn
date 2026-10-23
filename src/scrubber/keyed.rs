//! Personal fields that have no checksum: a person's name, a postal address and a username.
//!
//! They are redacted only from an explicit key next to the value, exactly as the Node.js
//! scrubber does (`lib/scrub/patterns.js`, `keyedFinder`):
//! - HTTP headers (`X-User-Name: ...`, also as a JSON key or inside `-H '...'`);
//! - query strings and form bodies (`?name=...&user=...`, or a `key=value` line that starts in
//!   column 0).
//!
//! Only the value is the span; the key stays readable. A bare value without its key is never
//! matched. Code (keyword arguments, JSON schemas, ALL-CAPS environment variables) is not in
//! scope on purpose.

use regex::Regex;
use std::sync::OnceLock;

/// Value validator: the decoded value and whether the key is a strong one (a header, or a
/// form key that is not a bare `name`).
type Valid = fn(&str, bool) -> bool;

struct Finder {
    header: Regex,
    form: Regex,
    valid: Valid,
}

/// JavaScript `\s`: the Rust `char::is_whitespace` differs (it has U+0085, not U+FEFF).
fn js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0b}' | '\u{0c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

fn js_trim(s: &str) -> &str {
    s.trim_matches(js_space)
}

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

fn is_line_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

fn char_before(text: &str, i: usize) -> Option<char> {
    text[..i].chars().next_back()
}

fn char_after(text: &str, i: usize) -> Option<char> {
    text[i..].chars().next()
}

fn is_letter(c: Option<char>) -> bool {
    c.is_some_and(|c| letter_re().is_match(c.encode_utf8(&mut [0; 4])))
}

fn letter_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^\p{L}$").unwrap())
}

/// A placeholder, a template or a null-like word: never a real value.
fn keyed_placeholder(d: &str) -> bool {
    if d.chars().any(is_line_terminator) {
        // `.` does not match a line terminator, and every form of the pattern has one.
        return false;
    }
    let b = d.as_bytes();
    let (first, last) = (b.first().copied(), b.last().copied());
    if (first == Some(b'{') && last == Some(b'}') && b.len() >= 2)
        || first == Some(b'$')
        || (first == Some(b'<') && last == Some(b'>') && b.len() >= 2)
        || (first == Some(b'[') && last == Some(b']') && b.len() >= 2)
    {
        return true;
    }
    if b.len() >= 5 && b[..5].eq_ignore_ascii_case(b"__ZN_") {
        return true;
    }
    if d.eq_ignore_ascii_case("%s") || d.eq_ignore_ascii_case("%d") {
        return true;
    }
    const WORDS: [&str; 10] = [
        "null",
        "undefined",
        "none",
        "nil",
        "true",
        "false",
        "n/a",
        "na",
        "anonymous",
        "unknown",
    ];
    if WORDS.iter().any(|w| d.eq_ignore_ascii_case(w)) {
        return true;
    }
    !d.is_empty()
        && (d.bytes().all(|c| c == b'-')
            || d.bytes().all(|c| c == b'*')
            || d.bytes().all(|c| c == b'x' || c == b'X'))
}

const NOT_A_PERSON: [&str; 29] = [
    "root",
    "admin",
    "administrator",
    "system",
    "guest",
    "default",
    "test",
    "tester",
    "user",
    "username",
    "name",
    "bot",
    "ci",
    "runner",
    "ubuntu",
    "ec2-user",
    "nobody",
    "www-data",
    "service",
    "me",
    "self",
    "github-actions",
    "dependabot",
    "example",
    "git",
    "postgres",
    "mysql",
    "nginx",
    "deploy",
];
const NAME_PARTICLES: [&str; 11] = [
    "de", "del", "la", "van", "von", "da", "di", "bin", "al", "el", "y",
];

fn word_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^\p{L}[\p{L}'.-]*$").unwrap())
}

fn upper_start_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^\p{Lu}").unwrap())
}

fn two_letters_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\p{L}{2}").unwrap())
}

fn valid_person_name(d: &str, strong: bool) -> bool {
    let len = utf16_len(d);
    if !(2..=80).contains(&len) {
        return false;
    }
    let words: Vec<&str> = js_trim(d)
        .split(js_space)
        .filter(|w| !w.is_empty())
        .collect();
    if words.is_empty() || words.len() > 5 {
        return false;
    }
    if !words.iter().all(|w| word_re().is_match(w)) {
        return false;
    }
    if words.len() == 1 {
        let w = words[0];
        let lower = w.to_lowercase();
        return strong && utf16_len(w) >= 2 && !NOT_A_PERSON.contains(&lower.as_str());
    }
    if strong {
        return true;
    }
    // A generic key (`name=`): every word capitalised, so build names stay out.
    words.iter().all(|w| {
        let lower = w.to_lowercase();
        upper_start_re().is_match(w) || NAME_PARTICLES.contains(&lower.as_str())
    })
}

fn valid_username(d: &str, _strong: bool) -> bool {
    let b = d.as_bytes();
    if !(2..=64).contains(&b.len()) || !b[0].is_ascii_alphanumeric() {
        return false;
    }
    if !b[1..]
        .iter()
        .all(|&c| c.is_ascii_alphanumeric() || c == b'.' || c == b'_' || c == b'-')
    {
        return false;
    }
    if b.iter().all(|c| c.is_ascii_digit()) || NOT_A_PERSON.contains(&d.to_lowercase().as_str()) {
        return false;
    }
    // A UUID is not a username.
    let is_uuid = b.len() >= 14
        && b[..8].iter().all(|c| c.is_ascii_hexdigit())
        && b[8] == b'-'
        && b[9..13].iter().all(|c| c.is_ascii_hexdigit())
        && b[13] == b'-';
    !is_uuid
}

fn valid_address(d: &str, _strong: bool) -> bool {
    let len = utf16_len(d);
    if !(6..=160).contains(&len) || d.contains("://") || d.contains('@') {
        return false;
    }
    if d.len() >= 2 && d.as_bytes()[..2].eq_ignore_ascii_case(b"0x") {
        return false;
    }
    let tokens = d
        .split(|c: char| js_space(c) || c == ',')
        .filter(|t| !t.is_empty())
        .count();
    tokens >= 2 && d.bytes().any(|c| c.is_ascii_digit()) && two_letters_re().is_match(d)
}

/// `decodeURIComponent` of a form value with `+` as a space; the `+`-decoded text when the
/// percent escapes are malformed.
fn decode_form_value(v: &str) -> String {
    let s = v.replace('+', " ");
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = |k: usize| b.get(k).and_then(|c| (*c as char).to_digit(16));
            match (hex(i + 1), hex(i + 2)) {
                (Some(h), Some(l)) => {
                    out.push((h * 16 + l) as u8);
                    i += 3;
                }
                _ => return s,
            }
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).unwrap_or(s)
}

fn accept(valid: Valid, raw: &str, strong: bool, form: bool) -> bool {
    if raw.is_empty() {
        return false;
    }
    let decoded;
    let d = if form {
        decoded = decode_form_value(raw);
        js_trim(&decoded)
    } else {
        js_trim(raw)
    };
    !keyed_placeholder(d) && valid(d, strong)
}

fn finder(headers: &str, forms: &str, valid: Valid) -> Finder {
    Finder {
        header: Regex::new(&format!(r#"(?i-u)({headers})["']?[ \t]*:[ \t]*(["']?)"#)).unwrap(),
        form: Regex::new(&format!(r"(?i-u)({forms})=")).unwrap(),
        valid,
    }
}

fn name_finder() -> &'static Finder {
    static F: OnceLock<Finder> = OnceLock::new();
    F.get_or_init(|| {
        finder(
            "X-User-?Name|X-Full-?Name",
            "full_?name|name",
            valid_person_name,
        )
    })
}

fn username_finder() -> &'static Finder {
    static F: OnceLock<Finder> = OnceLock::new();
    F.get_or_init(|| {
        finder(
            "X-Username|X-User|X-Forwarded-User|X-Remote-User",
            "username|user|login",
            valid_username,
        )
    })
}

fn address_finder() -> &'static Finder {
    static F: OnceLock<Finder> = OnceLock::new();
    F.get_or_init(|| finder("X-Address", "address", valid_address))
}

/// Advance one character (a failed lookbehind: the regex engine tries the next start).
fn next_start(text: &str, s: usize) -> usize {
    s + char_after(text, s).map_or(1, char::len_utf8)
}

fn header_spans(f: &Finder, text: &str, out: &mut Vec<(usize, usize)>) {
    let mut pos = 0;
    while pos <= text.len() {
        let Some(caps) = f.header.captures_at(text, pos) else {
            break;
        };
        let whole = caps.get(0).unwrap();
        // (?<![A-Za-z0-9_-]) before the key
        if matches!(char_before(text, whole.start()), Some(c) if c.is_ascii_alphanumeric() || c == '_' || c == '-')
        {
            pos = next_start(text, whole.start());
            continue;
        }
        let start = whole.end();
        let quote = caps.get(2).and_then(|m| m.as_str().chars().next());
        let mut i = start;
        for (off, c) in text[start..].char_indices() {
            let idx = start + off;
            if c == '\n' || c == '\r' || c == '"' {
                break;
            }
            if quote == Some(c) {
                break;
            }
            if c == '\''
                && !(is_letter(char_before(text, idx)) && is_letter(char_after(text, idx + 1)))
            {
                break;
            }
            i = idx + c.len_utf8();
        }
        let mut end = i;
        while end > start {
            let c = char_before(text, end).unwrap();
            if js_space(c) || c == ',' || c == ';' || c == '\\' {
                end -= c.len_utf8();
            } else {
                break;
            }
        }
        if end > start && accept(f.valid, &text[start..end], true, false) {
            out.push((start, end));
        }
        pos = whole.end().max(i);
    }
}

fn form_spans(f: &Finder, text: &str, out: &mut Vec<(usize, usize)>) {
    let mut pos = 0;
    while pos <= text.len() {
        let Some(caps) = f.form.captures_at(text, pos) else {
            break;
        };
        let whole = caps.get(0).unwrap();
        let key = caps.get(1).unwrap().as_str();
        let k_start = whole.start();
        // (?<![A-Za-z0-9_.-]) before the key
        if matches!(char_before(text, k_start), Some(c) if c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-')
        {
            pos = next_start(text, k_start);
            continue;
        }
        pos = whole.end();
        let before = char_before(text, k_start).unwrap_or('\n');
        let query = before == '?' || before == '&';
        if !query && before != '\n' && before != '\r' {
            continue;
        }
        // USER=... style environment variables
        if !query && !key.bytes().any(|c| c.is_ascii_lowercase()) {
            continue;
        }
        let start = whole.end();
        let mut i = start;
        for (off, c) in text[start..].char_indices() {
            if matches!(c, '\n' | '\r' | '&' | '"' | '\'') {
                break;
            }
            if query && matches!(c, ' ' | '\t' | '#') {
                break;
            }
            i = start + off + c.len_utf8();
        }
        let mut end = i;
        while end > start {
            let c = char_before(text, end).unwrap();
            if js_space(c) || c == ',' || c == ';' {
                end -= c.len_utf8();
            } else {
                break;
            }
        }
        let strong = !key.eq_ignore_ascii_case("name");
        if end > start && accept(f.valid, &text[start..end], strong, true) {
            out.push((start, end));
        }
        pos = pos.max(i);
    }
}

/// Sorted, non-overlapping spans of the values of one keyed field.
fn spans(f: &Finder, text: &str) -> Vec<(usize, usize)> {
    let mut all = Vec::new();
    header_spans(f, text, &mut all);
    form_spans(f, text, &mut all);
    all.sort_unstable();
    let mut out: Vec<(usize, usize)> = Vec::with_capacity(all.len());
    for (s, e) in all {
        if out.last().is_none_or(|&(_, le)| s >= le) {
            out.push((s, e));
        }
    }
    out
}

pub(super) fn person_name_spans(text: &str) -> Vec<(usize, usize)> {
    spans(name_finder(), text)
}

pub(super) fn username_spans(text: &str) -> Vec<(usize, usize)> {
    spans(username_finder(), text)
}

pub(super) fn address_spans(text: &str) -> Vec<(usize, usize)> {
    spans(address_finder(), text)
}
