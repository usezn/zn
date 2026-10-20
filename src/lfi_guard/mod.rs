//! Local File Inclusion (LFI) Guard Module
//!
//! High-performance detection of path traversal and sensitive file access patterns.

use aho_corasick::{AhoCorasick, AhoCorasickBuilder, MatchKind};
use std::sync::OnceLock;

/// Static Aho-Corasick automaton for LFI patterns
static LFI_AUTOMATON: OnceLock<AhoCorasick> = OnceLock::new();

/// Common LFI and path traversal patterns
const LFI_PATTERNS: &[&str] = &[
    "../",
    "..\\",
    "/etc/passwd",
    "/etc/shadow",
    "/etc/group",
    "/etc/hosts",
    "/proc/self",
    "/var/log/",
    "C:\\Windows\\",
    "C:/Windows/",
    ".ssh/id_",
    ".ssh/authorized_keys",
    ".aws/credentials",
    ".netrc",
    "_netrc",
    ".docker/config.json",
    ".kube/config",
    ".git-credentials",
    ".pgpass",
    ".config/gh/hosts.y",
    ".config/gcloud/credentials.db",
    ".config/gcloud/access_tokens.db",
    ".config/gcloud/application_default_credentials.json",
    ".azure/accesstokens.json",
    ".azure/msal_token_cache.json",
    "config.php",
    "wp-config.php",
    ".env",
    ".git/",
    "htaccess",
];

/// Initialize the Aho-Corasick automaton
fn get_automaton() -> &'static AhoCorasick {
    LFI_AUTOMATON.get_or_init(|| {
        AhoCorasickBuilder::new()
            .ascii_case_insensitive(true)
            .match_kind(MatchKind::LeftmostFirst)
            .build(LFI_PATTERNS)
            .expect("Failed to build LFI pattern automaton")
    })
}

/// Result of LFI detection
#[derive(Debug, Clone)]
pub struct LfiDetectionResult {
    /// Whether LFI was detected
    pub is_attack: bool,
    /// The pattern that matched (if any)
    pub matched_pattern: Option<String>,
}

/// Unify path separators: every backslash becomes `/` and runs of `/` collapse,
/// so `C:\\Windows\\x` (JSON-escaped) and `.aws\credentials` match the same
/// patterns as their `/` forms. Returns None when nothing changes.
fn normalize_separators(input: &str) -> Option<String> {
    if !input.contains('\\') {
        return None;
    }
    let mut out = String::with_capacity(input.len());
    let mut last_slash = false;
    for ch in input.chars() {
        let c = if ch == '\\' { '/' } else { ch };
        if c == '/' {
            if last_slash {
                continue;
            }
            last_slash = true;
        } else {
            last_slash = false;
        }
        out.push(c);
    }
    Some(out)
}

/// `.ssh/<name>_key`: a private key named by suffix (the Node policy blocks it too).
fn has_ssh_key_suffix(input: &str) -> bool {
    let lower = input.to_ascii_lowercase();
    let mut rest = lower.as_str();
    while let Some(i) = rest.find(".ssh/") {
        rest = &rest[i + 5..];
        let seg: String = rest
            .chars()
            .take_while(|c| {
                !matches!(
                    c,
                    '/' | '"' | '\'' | ' ' | '\t' | '\n' | '\r' | ';' | '|' | '&'
                )
            })
            .collect();
        if seg.len() > 4 && seg.ends_with("_key") {
            return true;
        }
    }
    false
}

fn first_match(input: &str) -> Option<String> {
    get_automaton()
        .find(input)
        .map(|m| LFI_PATTERNS[m.pattern().as_usize()].to_string())
}

/// Check if input contains LFI patterns
pub fn detect_lfi(input: &str) -> LfiDetectionResult {
    let mut hit = first_match(input);
    if hit.is_none() {
        let norm = normalize_separators(input);
        let text = norm.as_deref().unwrap_or(input);
        hit = if norm.is_some() {
            first_match(text)
        } else {
            None
        };
        if hit.is_none() && has_ssh_key_suffix(text) {
            hit = Some(".ssh/*_key".to_string());
        }
    }
    LfiDetectionResult {
        is_attack: hit.is_some(),
        matched_pattern: hit,
    }
}

/// Quick check if input contains LFI patterns
#[inline]
pub fn contains_lfi(input: &str) -> bool {
    detect_lfi(input).is_attack
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_path_traversal() {
        assert!(contains_lfi("../../../etc/passwd"));
        assert!(contains_lfi("....\\\\....\\\\windows\\\\system32"));
        assert!(contains_lfi("file:///../../../"));
    }

    #[test]
    fn test_sensitive_files() {
        assert!(contains_lfi("Read /etc/passwd for user info"));
        assert!(contains_lfi("Check /etc/shadow for hashes"));
        assert!(contains_lfi("Look in /proc/self/environ"));
        assert!(contains_lfi("cat /var/log/syslog"));
    }

    #[test]
    fn test_windows_paths() {
        assert!(contains_lfi("C:\\Windows\\System32\\config"));
        assert!(contains_lfi("C:/Windows/System32/drivers"));
    }

    #[test]
    fn test_dot_files() {
        assert!(contains_lfi("Check .ssh/id_rsa for keys"));
        assert!(contains_lfi("Read .git/config"));
        assert!(contains_lfi("Load .env for secrets"));
        assert!(contains_lfi(".htaccess rules"));
    }

    #[test]
    fn test_config_files() {
        assert!(contains_lfi("Include wp-config.php"));
        assert!(contains_lfi("Look at config.php"));
    }

    #[test]
    fn test_credential_files_both_separators() {
        for p in [
            "/home/demo/.aws/credentials",
            "/home/demo/.ssh/id_ed25519",
            "/home/demo/.ssh/id_ecdsa",
            "/home/demo/.ssh/deploy_key",
            "/home/demo/.netrc",
            "/home/demo/.docker/config.json",
            "/home/demo/.kube/config",
            "/home/demo/.git-credentials",
            "/home/demo/.pgpass",
            "/home/demo/.config/gcloud/credentials.db",
            "/home/demo/.azure/accessTokens.json",
        ] {
            assert!(contains_lfi(p), "{p}");
            assert!(contains_lfi(&p.replace('/', "\\")), "{p} backslash");
            assert!(contains_lfi(&p.to_uppercase()), "{p} upper");
        }
        assert!(!contains_lfi("src/main.rs"));
        assert!(!contains_lfi("/home/demo/.ssh/known_hosts"));
    }

    #[test]
    fn test_safe_input() {
        assert!(!contains_lfi("Read the README.md file"));
        assert!(!contains_lfi("Check the documentation"));
        assert!(!contains_lfi("Create a new folder called 'data'"));
        assert!(!contains_lfi("Normal file: report.pdf"));
    }

    #[test]
    fn test_detection_result() {
        let result = detect_lfi("Show me /etc/passwd");
        assert!(result.is_attack);
        assert_eq!(result.matched_pattern, Some("/etc/passwd".to_string()));

        let safe_result = detect_lfi("Hello world");
        assert!(!safe_result.is_attack);
        assert!(safe_result.matched_pattern.is_none());
    }
}
