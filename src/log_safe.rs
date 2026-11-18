//! Helpers for values that reach the logs.
//!
//! Anything that comes from a request (Origin header, tool name, agent id,
//! error text) can hold line breaks, ANSI escape sequences or Unicode
//! direction controls that forge log lines or rewrite a terminal. `log_safe`
//! replaces them with visible escapes and caps the length. `path_for_log`
//! shows the home directory as `~` so info-level logs do not carry it.

use std::borrow::Cow;
use std::path::Path;

/// Longest value, in characters, that `log_safe` keeps.
pub const LOG_VALUE_MAX_CHARS: usize = 200;

fn needs_escape(c: char) -> bool {
    c.is_control()
        || matches!(
            c,
            '\u{061C}'
                | '\u{200E}'
                | '\u{200F}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202A}'..='\u{202E}'
                | '\u{2066}'..='\u{2069}'
        )
}

/// Make a request-derived value safe to print: control characters (including
/// `\r`, `\n` and ESC) and Unicode direction controls become `\u{..}` escapes,
/// and anything past `LOG_VALUE_MAX_CHARS` characters is cut with a marker.
/// Clean short values are returned without allocating.
pub fn log_safe(input: &str) -> Cow<'_, str> {
    let clean = !input.chars().any(needs_escape);
    let short = input.chars().nth(LOG_VALUE_MAX_CHARS).is_none();
    if clean && short {
        return Cow::Borrowed(input);
    }
    let mut out = String::with_capacity(input.len().min(LOG_VALUE_MAX_CHARS * 2));
    for (n, c) in input.chars().enumerate() {
        if n >= LOG_VALUE_MAX_CHARS {
            out.push_str("...[truncated]");
            break;
        }
        if needs_escape(c) {
            out.push_str(&format!("\\u{{{:x}}}", c as u32));
        } else {
            out.push(c);
        }
    }
    Cow::Owned(out)
}

fn home_dir() -> Option<String> {
    std::env::var("HOME")
        .ok()
        .or_else(|| std::env::var("USERPROFILE").ok())
        .filter(|h| h.len() > 1)
}

fn replace_home(path: &str, home: Option<&str>) -> String {
    if let Some(home) = home {
        let home = home.trim_end_matches(['/', '\\']);
        if !home.is_empty() {
            if let Some(rest) = path.strip_prefix(home) {
                if rest.is_empty() || rest.starts_with('/') || rest.starts_with('\\') {
                    return format!("~{rest}");
                }
            }
        }
    }
    path.to_string()
}

/// A path for an info-level log line: the home directory shows as `~`.
pub fn path_for_log(path: &Path) -> String {
    replace_home(&path.to_string_lossy(), home_dir().as_deref())
}

/// Same as `path_for_log` for a path held as text.
pub fn path_str_for_log(path: &str) -> String {
    replace_home(path, home_dir().as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_short_values_pass_through_unchanged() {
        assert!(matches!(
            log_safe("https://app.example.com"),
            Cow::Borrowed(_)
        ));
        assert_eq!(log_safe("tool-é"), "tool-é");
    }

    #[test]
    fn control_characters_and_ansi_are_escaped() {
        let out = log_safe("a\r\nINFO forged\x1b[2J\x00b");
        assert!(!out.contains('\r') && !out.contains('\n') && !out.contains('\x1b'));
        assert!(!out.contains('\0'));
        assert_eq!(out, "a\\u{d}\\u{a}INFO forged\\u{1b}[2J\\u{0}b");
    }

    #[test]
    fn bidi_controls_are_escaped() {
        let out = log_safe("evil\u{202E}gnp.exe\u{2066}x\u{2069}\u{200F}");
        assert!(!out.chars().any(needs_escape));
        assert!(out.contains("\\u{202e}"));
    }

    #[test]
    fn long_values_are_capped() {
        let long = "x".repeat(5000);
        let out = log_safe(&long);
        assert!(out.chars().count() < LOG_VALUE_MAX_CHARS + 20);
        assert!(out.ends_with("[truncated]"));
        let exact = "y".repeat(LOG_VALUE_MAX_CHARS);
        assert_eq!(log_safe(&exact), exact.as_str());
    }

    #[test]
    fn cap_counts_characters_not_bytes() {
        let wide = "é".repeat(LOG_VALUE_MAX_CHARS);
        assert!(matches!(log_safe(&wide), Cow::Borrowed(_)));
    }

    #[test]
    fn home_prefix_becomes_tilde() {
        assert_eq!(
            replace_home("/home/ana/.claude/x.json", Some("/home/ana")),
            "~/.claude/x.json"
        );
        assert_eq!(replace_home("/home/ana", Some("/home/ana/")), "~");
        assert_eq!(
            replace_home("C:\\Users\\ana\\zn.db", Some("C:\\Users\\ana")),
            "~\\zn.db"
        );
    }

    #[test]
    fn other_paths_are_left_alone() {
        assert_eq!(
            replace_home("/home/anabel/x", Some("/home/ana")),
            "/home/anabel/x"
        );
        assert_eq!(
            replace_home("/srv/data/zn.db", Some("/home/ana")),
            "/srv/data/zn.db"
        );
        assert_eq!(replace_home("/srv/data", None), "/srv/data");
    }
}
