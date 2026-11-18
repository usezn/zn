//! SQL Injection Guard Module
//!
//! High-performance SQL injection detection using Aho-Corasick algorithm.
//! Provides O(n) pattern matching for 67+ attack patterns.

use aho_corasick::{AhoCorasick, AhoCorasickBuilder, MatchKind};
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
    // Comment-based attacks
    "--",
    "/*",
    "*/",
    "#",
    // Union-based attacks
    "union select",
    "union all select",
    "union distinct select",
    // Destructive commands
    "drop table",
    "drop database",
    "truncate table",
    "delete from",
    "insert into",
    "update set",
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

/// Check if input contains SQL injection patterns
///
/// Uses Aho-Corasick algorithm for O(n) multi-pattern matching,
/// much faster than checking each pattern individually.
///
/// # Arguments
/// * `input` - The string to check for SQL injection
///
/// # Returns
/// Detection result with matched pattern info
pub fn detect_sql_injection(input: &str) -> SqlDetectionResult {
    let automaton = get_automaton();

    // Find first match
    if let Some(mat) = automaton.find(input) {
        SqlDetectionResult {
            is_attack: true,
            matched_pattern: Some(SQL_PATTERNS[mat.pattern().as_usize()].to_string()),
            position: Some(mat.start()),
        }
    } else {
        SqlDetectionResult {
            is_attack: false,
            matched_pattern: None,
            position: None,
        }
    }
}

/// Quick check if input contains SQL injection patterns
///
/// Faster than `detect_sql_injection` when you don't need pattern details.
#[inline]
pub fn contains_sql_injection(input: &str) -> bool {
    get_automaton().is_match(input)
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
            // The raw full-width text is not ASCII, the folded text is.
            assert!(
                !contains_sql_injection(&wide),
                "raw {wide:?} unexpectedly matched"
            );
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
}
