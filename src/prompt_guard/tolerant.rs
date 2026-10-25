//! Invisible-tolerant variants of the prompt-injection patterns.
//!
//! The stripped view ("ignoreall...") and the spaced view ("ig nore all...") each read one use of the invisible
//! characters. A text that uses one as a space AND another inside a word ("ig<U+200B>nore<U+200B>all ...") fits
//! neither. The variant built here accepts any invisible character after every element of the pattern, and in
//! place of every whitespace element, so it matches that text with its invisible characters kept. Each run
//! of them is one MARK character in the text. It is the same
//! transformer as packages/zn-gate/lib/invisible_tolerant.js and packages/zn-gate-py/src/zn_gate/invisible_tolerant.py.
//!
//! A small tokenizer walks the pattern source: it knows escapes, character classes, groups and quantifiers, and
//! never inserts inside a class.

/// What the folded text holds in place of every run of invisible characters (see
/// `fold_system1_keep_invisible`): one control character, so the tolerant patterns need only a one-byte class.
pub const MARK: char = '\u{1}';
/// The same character as pattern source.
const MARK_SOURCE: &str = r"\x01";

/// Index after the escape that starts at `i` (`c[i]` is a backslash).
fn escape_end(c: &[char], i: usize) -> usize {
    let n = c.len();
    let braced = |from: usize| -> usize {
        match c[from..].iter().position(|&x| x == '}') {
            Some(p) => from + p + 1,
            None => n,
        }
    };
    match c.get(i + 1) {
        None => i + 1,
        Some('x') => {
            if c.get(i + 2) == Some(&'{') {
                braced(i + 3)
            } else {
                (i + 4).min(n)
            }
        }
        Some('u') => {
            if c.get(i + 2) == Some(&'{') {
                braced(i + 3)
            } else {
                (i + 6).min(n)
            }
        }
        Some('U') => {
            if c.get(i + 2) == Some(&'{') {
                braced(i + 3)
            } else {
                (i + 10).min(n)
            }
        }
        Some('p') | Some('P') => {
            if c.get(i + 2) == Some(&'{') {
                braced(i + 3)
            } else {
                (i + 3).min(n)
            }
        }
        Some(d) if d.is_ascii_digit() => {
            let mut j = i + 2;
            while j < n && c[j].is_ascii_digit() {
                j += 1;
            }
            j
        }
        Some(_) => i + 2,
    }
}

/// The class that opens at `i`: its end (exclusive), whether it is negated and whether it holds a space.
fn class_info(c: &[char], i: usize) -> (usize, bool, bool) {
    let n = c.len();
    let mut j = i + 1;
    let mut negated = false;
    if c.get(j) == Some(&'^') {
        negated = true;
        j += 1;
    }
    let mut ws = false;
    let mut depth = 1;
    if c.get(j) == Some(&']') {
        j += 1; // a "]" first in the class is a literal
    }
    while j < n {
        match c[j] {
            '\\' => {
                if c.get(j + 1) == Some(&'s') {
                    ws = true;
                }
                j = escape_end(c, j);
            }
            '[' => {
                depth += 1;
                j += 1;
            }
            ']' => {
                depth -= 1;
                j += 1;
                if depth == 0 {
                    break;
                }
            }
            ' ' => {
                ws = true;
                j += 1;
            }
            _ => j += 1,
        }
    }
    (j.min(n), negated, ws)
}

/// The end of a quantifier at `i` (`i` itself when there is none), with its lazy suffix.
fn quant_end(c: &[char], i: usize) -> usize {
    let n = c.len();
    let mut j = i;
    match c.get(j) {
        Some('?') | Some('*') | Some('+') => j += 1,
        Some('{') => {
            let mut k = j + 1;
            let mut seen = 0;
            while k < n && c[k].is_ascii_digit() {
                k += 1;
                seen += 1;
            }
            if c.get(k) == Some(&',') {
                k += 1;
                while k < n && c[k].is_ascii_digit() {
                    k += 1;
                    seen += 1;
                }
            }
            if c.get(k) == Some(&'}') && seen > 0 {
                j = k + 1;
            } else {
                return i;
            }
        }
        _ => return i,
    }
    if c.get(j) == Some(&'?') {
        j += 1;
    }
    j
}

/// The tolerant variant of a `regex` pattern source.
pub fn tolerant_source(source: &str) -> String {
    let inv = MARK_SOURCE.to_string();
    let gap = format!("{inv}*");
    let c: Vec<char> = source.chars().collect();
    let n = c.len();
    let part = |a: usize, b: usize| -> String { c[a..b].iter().collect() };
    let ws_atom = |tok: &str, quant: &str| -> String { format!("(?:{tok}|{inv}){quant}{gap}") };

    let mut out = String::new();
    let mut i = 0;
    while i < n {
        let ch = c[i];
        match ch {
            '\\' => {
                let e = escape_end(&c, i);
                let tok = part(i, e);
                if matches!(tok.as_str(), r"\b" | r"\B" | r"\A" | r"\z") {
                    out.push_str(&tok);
                    i = e;
                    continue;
                }
                let q = quant_end(&c, e);
                let quant = part(e, q);
                if tok == r"\s" || tok == r"\ " {
                    out.push_str(&ws_atom(&tok, &quant));
                } else {
                    out.push_str(&format!("{tok}{quant}{gap}"));
                }
                i = q;
            }
            '[' => {
                let (end, negated, ws) = class_info(&c, i);
                let tok = part(i, end);
                let q = quant_end(&c, end);
                let quant = part(end, q);
                if ws && !negated {
                    out.push_str(&ws_atom(&tok, &quant));
                } else {
                    out.push_str(&format!("{tok}{quant}{gap}"));
                }
                i = q;
            }
            '(' => {
                // Flags such as (?i-u) change nothing about the elements; (?i:...) opens a group.
                let mut j = i + 1;
                if c.get(j) == Some(&'?') {
                    j += 1;
                    let mut k = j;
                    while k < n && (c[k].is_ascii_alphabetic() || c[k] == '-') {
                        k += 1;
                    }
                    if k > j && c.get(k) == Some(&')') {
                        out.push_str(&part(i, k + 1));
                        i = k + 1;
                        continue;
                    }
                    if k > j && c.get(k) == Some(&':') {
                        j = k + 1;
                    } else if c.get(j) == Some(&':') {
                        j += 1;
                    } else if c.get(j) == Some(&'<')
                        || (c.get(j) == Some(&'P') && c.get(j + 1) == Some(&'<'))
                    {
                        j = match c[j..].iter().position(|&x| x == '>') {
                            Some(p) => j + p + 1,
                            None => n,
                        };
                    }
                }
                out.push_str(&part(i, j));
                i = j;
            }
            ')' => {
                let q = quant_end(&c, i + 1);
                out.push(')');
                out.push_str(&part(i + 1, q));
                out.push_str(&gap);
                i = q;
            }
            '|' | '^' | '$' => {
                out.push(ch);
                i += 1;
            }
            '.' => {
                let q = quant_end(&c, i + 1);
                out.push_str(&part(i, q));
                out.push_str(&gap);
                i = q;
            }
            '?' | '*' | '+' => {
                out.push(ch);
                i += 1;
            }
            _ => {
                let q = quant_end(&c, i + 1);
                let quant = part(i + 1, q);
                if ch == ' ' {
                    out.push_str(&ws_atom(" ", &quant));
                } else {
                    out.push_str(&format!("{ch}{quant}{gap}"));
                }
                i = q;
            }
        }
    }
    out
}
