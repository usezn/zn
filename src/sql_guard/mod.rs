//! SQL Injection Guard Module
//!
//! SQL injection detection. Fixed phrases are matched with the Aho-Corasick
//! algorithm (O(n)); the markers that also appear in ordinary text (comment
//! marks `--`, `/*` and `#`, and the words of `DELETE FROM`, `INSERT INTO` and
//! `UPDATE ... SET`) are matched only in the shape they have in a statement.
//! Full-width punctuation, letters and spaces are folded to ASCII first, so a
//! look-alike character cannot step around a narrowed pattern.

use aho_corasick::{AhoCorasick, AhoCorasickBuilder, MatchKind};
use std::borrow::Cow;
use std::sync::OnceLock;

/// Static Aho-Corasick automaton for SQL injection patterns
static SQL_AUTOMATON: OnceLock<AhoCorasick> = OnceLock::new();

/// SQL injection attack patterns
const SQL_PATTERNS: &[&str] = &[
    // Basic injection patterns
    "' or '1'='1",
    "' or 1=1",
    "\" or \"1\"=\"1",
    "\" or 1=1",
    "or 1=1--",
    "or 1=1#",
    "' or ''='",
    "' or 'x'='x",
    "') or ('1'='1",
    "') or ('1'='1",
    "') or ('x'='x",
    // Generic Tautologies (High risk of false positives, but safer)
    " or 1=1",
    " or 0=0",
    " or true",
    // Comment-based attacks. The bare marks `--`, `/*`, `*/` and `#` are not
    // patterns: see `find_contextual`.
    "/*!",
    // Union-based attacks
    "union select",
    "union all select",
    "union distinct select",
    // Destructive commands
    "drop table",
    "drop database",
    "truncate table",
    // Information extraction
    "information_schema",
    "sysobjects",
    "syscolumns",
    "pg_tables",
    "pg_catalog",
    // Function-based attacks
    "concat(",
    "char(",
    "chr(",
    "substr(",
    "substring(",
    "ascii(",
    "hex(",
    "unhex(",
    "benchmark(",
    "sleep(",
    "waitfor delay",
    "pg_sleep(",
    // Stacked queries
    "; drop",
    "; delete",
    "; insert",
    "; update",
    "; truncate",
    "; exec",
    "; execute",
    // Blind SQL injection
    "' and '1'='1",
    "' and '1'='2",
    "and 1=1",
    "and 1=2",
    "' and sleep(",
    "' and benchmark(",
    // Error-based
    "extractvalue(",
    "updatexml(",
    "floor(rand(",
    // Auth bypass
    "admin'--",
    "admin'#",
    "' or 'a'='a",
    "') or 'a'='a",
    // Second-order
    "'; waitfor delay",
];

/// Initialize the Aho-Corasick automaton
fn get_automaton() -> &'static AhoCorasick {
    SQL_AUTOMATON.get_or_init(|| {
        AhoCorasickBuilder::new()
            .ascii_case_insensitive(true)
            .match_kind(MatchKind::LeftmostFirst)
            .build(SQL_PATTERNS)
            .expect("Failed to build SQL injection pattern automaton")
    })
}

/// Result of SQL injection detection
#[derive(Debug, Clone)]
pub struct SqlDetectionResult {
    /// Whether SQL injection was detected
    pub is_attack: bool,
    /// The pattern that matched (if any)
    pub matched_pattern: Option<String>,
    /// Position in input where pattern was found
    pub position: Option<usize>,
}

/// The text the patterns run on, with a map from its byte offsets back to the
/// input. Full-width ASCII forms (U+FF01 to U+FF5E) and the ideographic space
/// become their ASCII character, and an inline comment with no white space
/// inside (`/**/`, `/*x*/`), the usual stand-in for a space, becomes a space.
struct Normalized<'a> {
    text: Cow<'a, str>,
    /// Input byte offset of each byte of `text`; empty when `text` is the input itself.
    map: Vec<usize>,
}

impl Normalized<'_> {
    fn original_offset(&self, at: usize) -> usize {
        self.map.get(at).copied().unwrap_or(at)
    }
}

fn normalize(input: &str) -> Normalized<'_> {
    if input.is_ascii() && !input.contains("/*") {
        return Normalized {
            text: Cow::Borrowed(input),
            map: Vec::new(),
        };
    }
    // First fold full-width forms, keeping each character's offset in the input.
    let chars: Vec<(char, usize)> = input
        .char_indices()
        .map(|(at, ch)| {
            let folded = match ch {
                '\u{3000}' => ' ',
                '\u{FF01}'..='\u{FF5E}' => char::from_u32(ch as u32 - 0xFEE0).unwrap_or(ch),
                other => other,
            };
            (folded, at)
        })
        .collect();
    // Then turn short inline comments into a space.
    let mut text = String::with_capacity(input.len());
    let mut map: Vec<usize> = Vec::with_capacity(input.len());
    let mut i = 0;
    while i < chars.len() {
        let (ch, at) = chars[i];
        if ch == '/' && chars.get(i + 1).is_some_and(|&(c, _)| c == '*') {
            let rest: String = chars[i..].iter().map(|&(c, _)| c).take(20).collect();
            if let Some(len) = short_inline_comment(&rest) {
                text.push(' ');
                map.push(at);
                // The comment is all ASCII: one char per byte.
                i += len;
                continue;
            }
        }
        let start = text.len();
        text.push(ch);
        map.extend(std::iter::repeat_n(at, text.len() - start));
        i += 1;
    }
    Normalized {
        text: Cow::Owned(text),
        map,
    }
}

/// Length of a `/* ... */` comment at the start of `s` whose body has no white
/// space and is at most 16 bytes (an empty `/**/` included), or `None`.
fn short_inline_comment(s: &str) -> Option<usize> {
    let rest = s.strip_prefix("/*")?;
    let end = rest.find("*/")?;
    let body = &rest[..end];
    if end <= 16
        && body.is_ascii()
        && !body.chars().any(char::is_whitespace)
        && !body.starts_with('!')
    {
        Some(2 + end + 2)
    } else {
        None
    }
}

fn is_word(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// The byte after any run of spaces, tabs and line breaks starting at `from`.
fn skip_blank(b: &[u8], mut from: usize) -> usize {
    while from < b.len() && b[from].is_ascii_whitespace() {
        from += 1;
    }
    from
}

/// A table or column name at `from`: word characters, dots, `$`, `@`, back
/// ticks, brackets and double quotes. Returns the end, or `from` if there is none.
fn skip_ident(b: &[u8], from: usize) -> usize {
    let mut i = from;
    while i < b.len() && (is_word(b[i]) || matches!(b[i], b'.' | b'$' | b'@' | b'`' | b'[' | b']'))
    {
        i += 1;
    }
    i
}

fn word_at(b: &[u8], at: usize, word: &str) -> bool {
    let w = word.as_bytes();
    b.len() >= at + w.len()
        && b[at..at + w.len()].eq_ignore_ascii_case(w)
        && !b.get(at + w.len()).copied().is_some_and(is_word)
}

/// True when `at` begins a word (the byte before it is not a word character).
fn word_start(b: &[u8], at: usize) -> bool {
    at == 0 || !is_word(b[at - 1])
}

/// A comment mark (`len` bytes at `at`) in the position it has in an injection:
/// right after a closed value, as in `admin'--` or `1';#`, or after one at the
/// end of the text (`' -- `). `--help`, `Order #1234` and `Section 3 -- Results`
/// are not.
fn comment_after_value(b: &[u8], at: usize, len: usize) -> bool {
    let mut j = at;
    while j > 0 && matches!(b[j - 1], b' ' | b'\t') {
        j -= 1;
    }
    if j == 0 {
        return false;
    }
    let spaced = j != at;
    let prev = b[j - 1];
    let after = at + len;
    let at_end = {
        let rest = &b[after..];
        let rest = rest.trim_ascii();
        rest.is_empty() || rest == b"-"
    };
    match prev {
        // A closing quote follows a value (`1'`, `a")`); an opening quote follows a space,
        // `(` or `=`.
        b'\'' | b'"' => {
            let before_quote = if j >= 2 { b[j - 2] } else { b' ' };
            let closes = is_word(before_quote) || before_quote == b')';
            closes && (!spaced || at_end)
        }
        b';' | b')' => {
            if spaced {
                at_end
            } else {
                !b.get(after).copied().is_some_and(is_word)
            }
        }
        _ => false,
    }
}

/// `INSERT INTO name (`, `name VALUES`, `name SELECT` or `name SET`.
fn insert_statement(b: &[u8], at: usize) -> bool {
    if !(word_start(b, at) && word_at(b, at, "insert")) {
        return false;
    }
    let i = skip_blank(b, at + "insert".len());
    if !word_at(b, i, "into") {
        return false;
    }
    let i = skip_blank(b, i + "into".len());
    let end = skip_ident(b, i);
    if end == i {
        return false;
    }
    let i = skip_blank(b, end);
    b.get(i) == Some(&b'(')
        || word_at(b, i, "values")
        || word_at(b, i, "select")
        || word_at(b, i, "set")
}

/// `DELETE FROM name` ending the text, a statement (`;`) or a clause
/// (`WHERE`, `LIMIT`, `ORDER`, `USING`, `OUTPUT`).
fn delete_statement(b: &[u8], at: usize) -> bool {
    if !(word_start(b, at) && word_at(b, at, "delete")) {
        return false;
    }
    let i = skip_blank(b, at + "delete".len());
    if !word_at(b, i, "from") {
        return false;
    }
    let i = skip_blank(b, i + "from".len());
    let end = skip_ident(b, i);
    if end == i {
        return false;
    }
    let i = skip_blank(b, end);
    i >= b.len()
        || b[i] == b';'
        || ["where", "limit", "order", "using", "output"]
            .iter()
            .any(|w| word_at(b, i, w))
}

/// `UPDATE name SET column =`.
fn update_statement(b: &[u8], at: usize) -> bool {
    if !(word_start(b, at) && word_at(b, at, "update")) {
        return false;
    }
    let i = skip_blank(b, at + "update".len());
    let end = skip_ident(b, i);
    if end == i {
        return false;
    }
    let i = skip_blank(b, end);
    if !word_at(b, i, "set") {
        return false;
    }
    let i = skip_blank(b, i + "set".len());
    let end = skip_ident(b, i);
    if end == i {
        return false;
    }
    b.get(skip_blank(b, end)) == Some(&b'=')
}

/// The earliest match of the patterns that need their surroundings: the
/// comment marks and the three statements. Returns the name of the pattern and
/// its offset in `text`.
fn find_contextual(text: &str) -> Option<(&'static str, usize)> {
    let b = text.as_bytes();
    for at in 0..b.len() {
        match b[at] {
            b'-' if b.get(at + 1) == Some(&b'-') && comment_after_value(b, at, 2) => {
                return Some(("--", at));
            }
            b'#' if comment_after_value(b, at, 1) => return Some(("#", at)),
            b'/' if b.get(at + 1) == Some(&b'*') => {
                // `admin'/*`, but not a quoted code comment.
                if at > 0
                    && b[at - 1] == b'\''
                    && at >= 2
                    && (is_word(b[at - 2]) || b[at - 2] == b')')
                {
                    return Some(("/*", at));
                }
            }
            b'i' | b'I' if insert_statement(b, at) => return Some(("insert into", at)),
            b'd' | b'D' if delete_statement(b, at) => return Some(("delete from", at)),
            b'u' | b'U' if update_statement(b, at) => return Some(("update set", at)),
            _ => {}
        }
    }
    None
}

/// Check if input contains SQL injection patterns
///
/// # Arguments
/// * `input` - The string to check for SQL injection
///
/// # Returns
/// Detection result with matched pattern info
pub fn detect_sql_injection(input: &str) -> SqlDetectionResult {
    let norm = normalize(input);
    let text: &str = &norm.text;

    let fixed = get_automaton().find(text).map(|mat| {
        (
            SQL_PATTERNS[mat.pattern().as_usize()].to_string(),
            mat.start(),
        )
    });
    let contextual = find_contextual(text).map(|(name, at)| (name.to_string(), at));
    let first = match (fixed, contextual) {
        (Some(a), Some(b)) => Some(if b.1 < a.1 { b } else { a }),
        (a, b) => a.or(b),
    };
    match first {
        Some((pattern, at)) => SqlDetectionResult {
            is_attack: true,
            matched_pattern: Some(pattern),
            position: Some(norm.original_offset(at)),
        },
        None => SqlDetectionResult {
            is_attack: false,
            matched_pattern: None,
            position: None,
        },
    }
}

/// Quick check if input contains SQL injection patterns
#[inline]
pub fn contains_sql_injection(input: &str) -> bool {
    let norm = normalize(input);
    get_automaton().is_match(&*norm.text) || find_contextual(&norm.text).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_basic_injection() {
        assert!(contains_sql_injection("' or '1'='1"));
        assert!(contains_sql_injection("1' OR '1'='1' --"));
        assert!(contains_sql_injection("admin'--"));
    }

    #[test]
    fn test_union_attack() {
        assert!(contains_sql_injection("1 UNION SELECT * FROM users"));
        assert!(contains_sql_injection("1' union all select null,null--"));
    }

    #[test]
    fn test_destructive_commands() {
        assert!(contains_sql_injection("'; DROP TABLE users;--"));
        assert!(contains_sql_injection("1; DELETE FROM sessions"));
    }

    #[test]
    fn test_safe_input() {
        assert!(!contains_sql_injection(
            "SELECT name FROM products WHERE id = 1"
        ));
        assert!(!contains_sql_injection("normal user input"));
        assert!(!contains_sql_injection("alice.doe@example.com"));
    }

    #[test]
    fn test_case_insensitive() {
        assert!(contains_sql_injection("UNION SELECT"));
        assert!(contains_sql_injection("Union Select"));
        assert!(contains_sql_injection("DROP TABLE"));
    }

    #[test]
    fn test_detection_result() {
        let result = detect_sql_injection("test' or '1'='1");
        assert!(result.is_attack);
        assert!(result.matched_pattern.is_some());
        assert!(result.position.is_some());
    }

    /// Ordinary text that must never be flagged: prose with SQL words used
    /// as plain English, documentation, code, and benign queries.
    const BENIGN_CORPUS: &[&str] = &[
        "Please select a shipping option and then drop by the store to pick up your order.",
        "The union of the two sets contains every element from both.",
        "We had to drop the table tennis tournament because of the weather.",
        "To insert the key, turn it clockwise until it clicks.",
        "The select committee will meet on Tuesday to discuss the proposal.",
        "Remember to update the settings before you restart the service.",
        "Delete the old notes when you have time.",
        "Use the select menu to pick a language, then press Save.",
        "This guide explains how an INNER JOIN differs from a LEFT JOIN.",
        "The union leaders agreed to meet again next week.",
        "Dropping support for Python 3.8 is planned for the next major release.",
        "Insert coin to continue.",
        "Insert your card and enter your PIN.",
        "Delete this message? Yes or no.",
        "Update: the release has been postponed until Thursday.",
        "Truncate the long titles to forty characters for the list view.",
        "Execute the plan step by step; do not skip the review.",
        "README: install the package, run the tests, and open an issue if something fails.",
        "fn main() { println!(\"hello world\"); }",
        "let total = items.iter().map(|i| i.price).sum::<f64>();",
        "// TODO: handle the empty list case before returning",
        "SELECT name FROM products WHERE id = 1",
        "SELECT id, email FROM users ORDER BY created_at DESC LIMIT 10",
        "alice.doe@example.com",
        "ls -la /home/user/example",
        "git commit -m \"fix typo in docs\"",
        "Meeting notes: discuss roadmap, assign owners, and review the budget.",
        "The quick brown fox jumps over the lazy dog.",
        "La reunion de equipo es a las diez; traiga los informes.",
        "Der Bericht wurde gestern fertiggestellt und versendet.",
        "Where do you want to go today? I'd like to visit the museum.",
        "Her name is O'Brien and she works in accounting.",
        "It's the user's choice whether to opt in or opt out.",
        "The sum of 2 and 3 is 5, and 5 minus 1 is 4.",
        "Set the volume to 11 and the brightness to 50 percent.",
        "https://example.com/docs/getting-started?lang=en",
        "price: $12.50, tax: $1.05, total: $13.55",
        "The password must contain at least eight characters.",
        "Sleep well, and see you in the morning.",
        "This function returns the length of the string.",
        "Please use a hex color such as ff8800 for the header.",
        "The database stores one row per user and one column per field.",
        "We will concatenate the two lists and then sort the result.",
        "Use the concat function to join strings.",
        "Write a char array of length ten.",
        "A substring is a contiguous sequence of characters within a string.",
        "The schema describes tables, columns and indexes in general terms.",
        "Use the catalog page to browse the products.",
        "Welcome to the system administration guide.",
        "the sleep schedule of toddlers",
        "x == y and y == z",
        "a = b",
        "",
        "   ",
    ];

    #[test]
    fn benign_corpus_stays_allowed() {
        for text in BENIGN_CORPUS {
            let r = detect_sql_injection(text);
            assert!(
                !r.is_attack,
                "false positive on {text:?}: matched {:?}",
                r.matched_pattern
            );
            assert!(r.matched_pattern.is_none() && r.position.is_none());
            assert!(!contains_sql_injection(text), "{text:?}");
        }
    }

    #[test]
    fn benign_corpus_stays_allowed_in_any_letter_case() {
        for text in BENIGN_CORPUS {
            assert!(!contains_sql_injection(&text.to_uppercase()), "{text:?}");
            assert!(!contains_sql_injection(&text.to_lowercase()), "{text:?}");
        }
    }

    #[test]
    fn benign_corpus_stays_allowed_inside_a_longer_text() {
        let long = BENIGN_CORPUS.join("\n");
        assert!(!contains_sql_injection(&long));
        assert!(!detect_sql_injection(&long).is_attack);
    }

    #[test]
    fn quick_check_and_detailed_result_agree() {
        let samples = [
            "normal user input",
            "1 UNION SELECT * FROM users",
            "'; DROP TABLE users;--",
            "Press # to continue",
            "",
        ];
        for s in samples.iter().chain(BENIGN_CORPUS.iter()) {
            assert_eq!(
                contains_sql_injection(s),
                detect_sql_injection(s).is_attack,
                "{s:?}"
            );
        }
    }

    #[test]
    fn match_position_points_at_the_pattern() {
        let input = "hello there 1 UNION SELECT x";
        let r = detect_sql_injection(input);
        assert!(r.is_attack);
        let pos = r.position.unwrap();
        let pat = r.matched_pattern.unwrap();
        assert_eq!(pat, "union select");
        assert!(input[pos..].to_ascii_lowercase().starts_with(&pat));
    }

    /// Every pattern made only of letters and single spaces, so that the
    /// folding step (which maps full-width letters and ideographic spaces
    /// back to ASCII) is enough to reach it.
    fn letter_patterns() -> Vec<&'static str> {
        SQL_PATTERNS
            .iter()
            .copied()
            .filter(|p| p.chars().all(|c| c.is_ascii_lowercase() || c == ' '))
            .collect()
    }

    fn to_full_width(s: &str) -> String {
        s.chars()
            .map(|c| match c {
                ' ' => '\u{3000}',
                'a'..='z' | 'A'..='Z' | '0'..='9' => {
                    char::from_u32(c as u32 - 0x20 + 0xFF00).unwrap()
                }
                other => other,
            })
            .collect()
    }

    fn alternate_case(s: &str) -> String {
        s.chars()
            .enumerate()
            .map(|(i, c)| {
                if i % 2 == 0 {
                    c.to_ascii_uppercase()
                } else {
                    c
                }
            })
            .collect()
    }

    #[test]
    fn letter_pattern_set_is_not_empty() {
        let p = letter_patterns();
        assert!(p.contains(&"union select"));
        assert!(p.contains(&"drop table"));
        assert!(p.len() >= 10, "only {} patterns", p.len());
    }

    #[test]
    fn folding_and_guard_agree_on_mixed_case_forms() {
        use crate::engine::rules::fold_system1;
        for p in letter_patterns() {
            let mixed = alternate_case(p);
            assert!(contains_sql_injection(&mixed), "{mixed:?}");
            assert_eq!(fold_system1(&mixed), mixed, "folding must not change ASCII");
            assert_eq!(
                contains_sql_injection(&fold_system1(&mixed)),
                contains_sql_injection(p),
                "{p:?}"
            );
        }
    }

    #[test]
    fn folding_and_guard_agree_on_full_width_forms() {
        use crate::engine::rules::fold_system1;
        for p in letter_patterns() {
            let wide = to_full_width(p);
            assert_ne!(wide, p);
            // The guard folds full-width forms itself, so the raw text matches too.
            assert!(contains_sql_injection(&wide), "raw {wide:?} was not caught");
            let folded = fold_system1(&wide);
            assert_eq!(folded, p);
            assert!(contains_sql_injection(&folded), "{p:?}");
            // Same verdict for the mixed-case full-width form.
            let wide_mixed = to_full_width(&alternate_case(p));
            assert!(contains_sql_injection(&fold_system1(&wide_mixed)), "{p:?}");
        }
    }

    #[test]
    fn folding_keeps_benign_full_width_and_mixed_case_text_allowed() {
        use crate::engine::rules::fold_system1;
        for text in BENIGN_CORPUS {
            let wide = to_full_width(text);
            assert!(!contains_sql_injection(&fold_system1(&wide)), "{text:?}");
            let mixed = alternate_case(text);
            assert!(!contains_sql_injection(&fold_system1(&mixed)), "{text:?}");
        }
    }

    #[test]
    fn benign_prose_with_sql_words_passes_the_managed_rules() {
        use crate::config::ManagedRulesConfig;
        use crate::engine::rules::ManagedRuleset;
        let cfg = ManagedRulesConfig::default();
        assert!(cfg.sql_injection);
        for text in [
            "Please select a shipping option and then drop by the store.",
            "The union leaders agreed to meet again next week.",
            "Insert coin to continue.",
        ] {
            let res = ManagedRuleset::evaluate(&cfg, "search_notes", text);
            assert!(res.is_ok(), "{text:?}: {res:?}");
        }
    }

    /// Text with `#`, `--`, `/* */` and the words of three statements used as
    /// plain writing or code. None of it may be flagged.
    const BENIGN_MARKS: &[&str] = &[
        "Order #1234 has shipped.",
        "See issue #42 and PR #43 for details.",
        "Press # to continue",
        "#include <stdio.h>",
        "# Heading\n\nSome text under the heading.",
        "color: #ff8800;",
        "Section 3 -- Results",
        "Section 3 - Results and 4 -- Discussion",
        "Tom -- the new hire -- starts on Monday.",
        "He said 'no' -- then left the room.",
        "(see above) -- and then continue",
        "run the tool with --help for usage",
        "git commit --amend --no-edit",
        "cargo test -- --nocapture",
        "\"--verbose\" turns on the log",
        "'--dry-run' only prints the plan",
        "echo ok # prints ok",
        "x = y  # trailing comment",
        "// TODO: handle the empty list case",
        "/* TODO: remove this block */",
        "/** Returns the total price. */",
        "fn total() -> u32 { /* sum */ 0 }",
        "\"/* quoted code comment */\"",
        "foo(); /* then bar */",
        "i--; j--;",
        "---\ntitle: Notes\n---",
        "<!-- an html comment -->",
        "Please update settings before you restart.",
        "We will update set up instructions soon.",
        "update the set of rules every week",
        "Update set to the new value.",
        "You can delete from the list any item you do not need.",
        "Delete from the cart the items you do not want.",
        "Insert into the slot the card you were given.",
        "insert into the box the two screws",
        "Please insert into this field your name.",
        "delete from now on",
        "How to insert into a sorted list: find the position, then shift.",
        "git log --since=2.weeks # recent work",
    ];

    #[test]
    fn benign_marks_stay_allowed() {
        for text in BENIGN_MARKS {
            let r = detect_sql_injection(text);
            assert!(
                !r.is_attack,
                "false positive on {text:?}: matched {:?}",
                r.matched_pattern
            );
            assert!(!contains_sql_injection(text), "{text:?}");
            assert!(!contains_sql_injection(&text.to_uppercase()), "{text:?}");
        }
    }

    #[test]
    fn benign_marks_stay_allowed_in_full_width_form() {
        for text in BENIGN_MARKS {
            let wide = to_full_width_all(text);
            assert!(!contains_sql_injection(&wide), "{wide:?}");
        }
    }

    /// Full-width forms of every printable ASCII character and the ideographic space.
    fn to_full_width_all(s: &str) -> String {
        s.chars()
            .map(|c| match c {
                ' ' => '\u{3000}',
                '!'..='~' => char::from_u32(c as u32 + 0xFEE0).unwrap(),
                other => other,
            })
            .collect()
    }

    /// The statements and comment tricks the guard has to keep blocking, in
    /// the plain ASCII form and in the full-width and mixed-case forms.
    const STILL_BLOCKED: &[&str] = &[
        "' or '1'='1",
        "1' OR '1'='1' --",
        "admin'--",
        "admin' --",
        "admin'#",
        "x';--",
        "x'); -- ",
        "1'#",
        "1' -- ",
        "1')--",
        "1'/* comment",
        "1 UNION SELECT * FROM users",
        "1' union all select null,null--",
        "'; DROP TABLE users;--",
        "1; DELETE FROM sessions",
        "DELETE FROM users",
        "DELETE FROM users WHERE 1=1",
        "delete from users;",
        "INSERT INTO users (name) VALUES ('x')",
        "insert into logs values (1)",
        "insert into t select * from u",
        "UPDATE users SET admin = 1",
        "update accounts set balance=0 where id=1",
        "id=1 UNION/**/SELECT/**/password FROM users",
        "id=1 union/*x*/select 1",
        "1 /*!50000 UNION */ SELECT 1",
        "SELECT * FROM information_schema.tables",
        "1 or 1=1--",
        "1 AND SLEEP(5)",
    ];

    #[test]
    fn injections_are_still_blocked() {
        for text in STILL_BLOCKED {
            assert!(contains_sql_injection(text), "{text:?}");
            assert!(detect_sql_injection(text).is_attack, "{text:?}");
            assert!(contains_sql_injection(&text.to_uppercase()), "{text:?}");
        }
    }

    #[test]
    fn injections_are_still_blocked_in_full_width_form() {
        for text in STILL_BLOCKED {
            let wide = to_full_width_all(text);
            assert_ne!(&wide, text);
            assert!(contains_sql_injection(&wide), "{wide:?}");
            let r = detect_sql_injection(&wide);
            assert!(r.is_attack, "{wide:?}");
            assert!(
                r.position.is_some_and(|p| wide.is_char_boundary(p)),
                "{wide:?}"
            );
        }
    }

    #[test]
    fn full_width_comment_marks_and_quotes_do_not_step_around_the_narrowing() {
        for text in [
            "admin\u{FF07}\u{FF0D}\u{FF0D}",
            "admin\u{FF07}\u{FF03}",
            "1\u{FF07}\u{3000}\u{FF0D}\u{FF0D}\u{3000}",
            "\u{FF07}\u{FF1B}DROP\u{3000}TABLE users",
            "DELETE\u{3000}FROM\u{3000}users\u{FF1B}",
        ] {
            assert!(contains_sql_injection(text), "{text:?}");
        }
    }

    #[test]
    fn match_position_is_an_offset_of_the_original_text() {
        let input = "caf\u{e9} \u{FF11}\u{FF07}\u{FF0D}\u{FF0D}";
        let r = detect_sql_injection(input);
        assert!(r.is_attack);
        assert_eq!(r.matched_pattern.as_deref(), Some("--"));
        let pos = r.position.unwrap();
        assert!(input.is_char_boundary(pos));
        assert!(input[pos..].starts_with('\u{FF0D}'));
    }
}
