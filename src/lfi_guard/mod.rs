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
    "/etc/sudoers",
    "/etc/master.passwd",
    ".bash_history",
    ".zsh_history",
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

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

fn has_pct_escape(input: &str) -> bool {
    input
        .as_bytes()
        .windows(3)
        .any(|w| w[0] == b'%' && hex_val(w[1]).is_some() && hex_val(w[2]).is_some())
}

/// One round of percent-decoding (`%2e` -> `.`); invalid escapes stay as they are.
fn percent_decode_once(input: &str) -> String {
    let b = input.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let (Some(h), Some(l)) = (hex_val(b[i + 1]), hex_val(b[i + 2])) {
                out.push(h * 16 + l);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Path normalization run before matching, on any text (with or without a
/// backslash): percent-decode (at most 2 rounds), backslash to `/`, collapse
/// runs of `/`, drop `/./` segments, strip trailing dots and spaces from each
/// segment (Windows ignores them). Case is handled by the case-insensitive
/// matcher. Returns None when nothing changes.
fn normalize_path_text(input: &str) -> Option<String> {
    let mut text = input.to_string();
    for _ in 0..2 {
        if !has_pct_escape(&text) {
            break;
        }
        text = percent_decode_once(&text);
    }
    let unified: String = text
        .chars()
        .map(|c| if c == '\\' { '/' } else { c })
        .collect();
    let mut kept: Vec<&str> = Vec::new();
    for seg in unified.split('/') {
        // `..` and `.` keep their dots so the traversal patterns still see them.
        let seg = if seg.chars().all(|c| c == '.') {
            seg
        } else {
            seg.trim_end_matches(['.', ' '])
        };
        if !seg.is_empty() && seg != "." {
            kept.push(seg);
        }
    }
    let mut out = kept.join("/");
    if unified.starts_with('/') {
        out.insert(0, '/');
    }
    if unified.ends_with('/') && !out.ends_with('/') {
        out.push('/');
    }
    if out == input {
        None
    } else {
        Some(out)
    }
}

/// `/proc/<pid>/environ` (any pid or `self`).
fn has_proc_environ(lower: &str) -> bool {
    let mut rest = lower;
    while let Some(i) = rest.find("/proc/") {
        rest = &rest[i + 6..];
        let seg: &str = rest.split('/').next().unwrap_or("");
        let tail = &rest[seg.len()..];
        if (seg == "self" || (!seg.is_empty() && seg.bytes().all(|b| b.is_ascii_digit())))
            && tail.starts_with("/environ")
        {
            return true;
        }
    }
    false
}

/// `/etc/ssh/ssh_host_<type>_key`: private host key (the `.pub` file is public).
fn has_ssh_host_key(lower: &str) -> bool {
    let mut rest = lower;
    while let Some(i) = rest.find("/etc/ssh/ssh_host_") {
        rest = &rest[i + 18..];
        let seg: String = rest
            .chars()
            .take_while(|c| {
                !matches!(
                    c,
                    '/' | '"' | '\'' | ' ' | '\t' | '\n' | '\r' | ';' | '|' | '&'
                )
            })
            .collect();
        if seg.ends_with("_key") {
            return true;
        }
    }
    false
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

fn extra_checks(text: &str) -> Option<String> {
    let lower = text.to_ascii_lowercase();
    if has_proc_environ(&lower) {
        return Some("/proc/<pid>/environ".to_string());
    }
    if has_ssh_host_key(&lower) {
        return Some("/etc/ssh/ssh_host_*_key".to_string());
    }
    if has_ssh_key_suffix(&lower) {
        return Some(".ssh/*_key".to_string());
    }
    None
}

/// Check if input contains LFI patterns. The original text is always checked,
/// then its normalized form (see `normalize_path_text`).
pub fn detect_lfi(input: &str) -> LfiDetectionResult {
    let mut hit = first_match(input).or_else(|| extra_checks(input));
    if hit.is_none() {
        if let Some(norm) = normalize_path_text(input) {
            hit = first_match(&norm).or_else(|| extra_checks(&norm));
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
    fn test_normalization_bypasses() {
        for p in [
            "/home/demo/./.aws/./credentials",
            "/home/demo//.aws//credentials",
            "/etc//./passwd",
            "/home/demo/.aws./credentials",
            r"C:\Users\demo\.aws \credentials",
            "/etc/pass%77d",
            "%2e%2e%2f%2e%2e%2fsecret",
            "%2fetc%2fpasswd",
            "%252fetc%252fpasswd",
            "/home/demo/.ssh%2fid_rsa",
        ] {
            assert!(contains_lfi(p), "{p}");
        }
    }

    #[test]
    fn test_missing_protected_files() {
        for p in [
            "/proc/1234/environ",
            "/proc/self/environ",
            "/etc/sudoers",
            "/etc/sudoers.d/90-demo",
            "/etc/ssh/ssh_host_ed25519_key",
            "/etc/ssh/ssh_host_rsa_key",
            "/home/demo/.bash_history",
            "/home/demo/.zsh_history",
            "/etc/master.passwd",
            "/proc/42/./environ",
        ] {
            assert!(contains_lfi(p), "{p}");
        }
        assert!(!contains_lfi("/etc/ssh/ssh_host_ed25519_key.pub"));
        assert!(!contains_lfi("/proc/cpuinfo"));
    }

    #[test]
    fn test_benign_normalization() {
        for p in [
            "src/./main.rs",
            "docs/100%25.md",
            "docs/100%.md",
            "https://example.com/a%20b?q=caf%C3%A9",
            "src//lib.rs",
            "notes/end.   ",
        ] {
            assert!(!contains_lfi(p), "{p}");
        }
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
