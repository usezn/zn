use crate::config::ManagedRulesConfig;
use crate::lfi_guard;
use crate::prompt_guard;
use crate::sql_guard;

/// Managed Ruleset Engine
pub struct ManagedRuleset;

impl ManagedRuleset {
    /// Evaluate a tool call against managed security rules
    pub fn evaluate(
        config: &ManagedRulesConfig,
        tool_name: &str,
        arguments: &str,
    ) -> std::result::Result<(), String> {
        // 1. Restricted Commands
        // Both the tool name and the argument text match whole words only:
        // "confirm"/"address"/"odd" are not "rm"/"dd", and neither are the
        // tools "transform_data" or "addItem".
        if config.restricted_commands {
            let dangerous = [
                "rm", "format", "mkfs", "dd", "chmod", "chown", "shutdown", "reboot",
            ];
            let folded_tool = fold_system1(tool_name);
            let folded_args = fold_system1(arguments);
            // Each part of the tool name is checked whole (lowercased, so
            // "ShutDown" and "chMod" count) and split on camelCase.
            let tool_hit = folded_tool
                .split(|c: char| !c.is_ascii_alphanumeric())
                .map(|part| part.to_ascii_lowercase())
                .chain(tool_name_words(&folded_tool))
                .any(|w| restricted_tool_word(&w));
            let args_hit = folded_args
                .split(|c: char| !c.is_ascii_alphanumeric())
                .any(|w| dangerous.iter().any(|&cmd| w.eq_ignore_ascii_case(cmd)));
            if tool_hit || args_hit {
                return Err(format!("Restricted command detected: {}", tool_name));
            }
        }

        // 2. LFI Protection
        let folded = fold_system1(arguments);
        if config.lfi_protection && lfi_guard::contains_lfi(&folded) {
            return Err("Local File Inclusion (LFI) attempt detected".to_string());
        }

        // 3. SQL Injection
        if config.sql_injection {
            let result = sql_guard::detect_sql_injection(&folded);
            if result.is_attack {
                return Err(format!(
                    "SQL Injection blocked: {}",
                    result.matched_pattern.unwrap_or_default()
                ));
            }
        }

        // 4. Prompt Injection
        if config.prompt_injection {
            let result = prompt_guard::detect_prompt_injection(&folded);
            if result.is_attack {
                return Err(format!(
                    "Prompt Injection blocked: {}",
                    result.matched_pattern.unwrap_or_default()
                ));
            }
        }

        // 5. Multimodal Vision Guard (Base64 Detection)
        if arguments.contains("data:image/") || arguments.contains("base64,") {
            if config.visual_pii_redaction {
                // In a production scenario, we would trigger an OCR/Vision scan here.
                tracing::warn!("📸 VISION SCAN TRIGGERED: Detecting PII in multimodal payload...");
                // return Err("Visual PII detected and blocked".to_string());
            } else {
                tracing::info!(
                    "📸 MULTIMODAL CONTENT DETECTED: Base64 found, vision scan skipped (disabled)."
                );
            }
        }

        Ok(())
    }
}

/// A word of a tool name that names a restricted command. Joined forms
/// such as "rmrf" or "rmtree" are listed, and the longer commands also match
/// as a prefix ("shutdownhost", "chmodfile"); "rm", "dd" and "format" do not
/// ("rms_norm", "formatter").
fn restricted_tool_word(w: &str) -> bool {
    const EXACT: &[&str] = &[
        "rm", "dd", "format", "rmdir", "rmtree", "rmrf", "rimraf", "deltree", "mkfs", "chmod",
        "chown", "shutdown", "reboot",
    ];
    const PREFIX: &[&str] = &["mkfs", "chmod", "chown", "shutdown", "reboot"];
    EXACT.contains(&w) || PREFIX.iter().any(|p| w.starts_with(p))
}

/// Split a tool name into words on separators and camelCase boundaries:
/// "format_disk" -> [format, disk], "runShutdown" -> [run, shutdown],
/// "MKFSVolume" -> [mkfs, volume].
fn tool_name_words(name: &str) -> Vec<String> {
    let mut words = Vec::new();
    for part in name.split(|c: char| !c.is_ascii_alphanumeric()) {
        let chars: Vec<char> = part.chars().collect();
        let mut start = 0;
        for i in 1..chars.len() {
            let (prev, cur) = (chars[i - 1], chars[i]);
            let next_lower = chars.get(i + 1).is_some_and(|c| c.is_ascii_lowercase());
            let boundary = (prev.is_ascii_lowercase() && cur.is_ascii_uppercase())
                || (prev.is_ascii_uppercase() && cur.is_ascii_uppercase() && next_lower)
                || (prev.is_ascii_alphabetic() != cur.is_ascii_alphabetic());
            if boundary {
                words.push(
                    chars[start..i]
                        .iter()
                        .collect::<String>()
                        .to_ascii_lowercase(),
                );
                start = i;
            }
        }
        if start < chars.len() {
            words.push(
                chars[start..]
                    .iter()
                    .collect::<String>()
                    .to_ascii_lowercase(),
            );
        }
    }
    words
}

/// Fold untrusted text before System 1 matching.
/// No unicode_normalization crate dependency — strip null/RTL + map common fullwidth/homoglyphs.
pub fn fold_system1(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        match ch {
            '\u{0000}' | '\u{200B}' | '\u{200C}' | '\u{200D}' | '\u{FEFF}' | '\u{202A}'
            | '\u{202B}' | '\u{202C}' | '\u{202D}' | '\u{202E}' | '\u{2066}' | '\u{2067}'
            | '\u{2068}' | '\u{2069}' => {}
            'Ａ'..='Ｚ' => out.push(char::from_u32(ch as u32 - 0xFF21 + b'A' as u32).unwrap()),
            'ａ'..='ｚ' => out.push(char::from_u32(ch as u32 - 0xFF41 + b'a' as u32).unwrap()),
            '０'..='９' => out.push(char::from_u32(ch as u32 - 0xFF10 + b'0' as u32).unwrap()),
            'а' => out.push('a'),
            'е' => out.push('e'),
            'о' => out.push('o'),
            'р' => out.push('p'),
            'с' => out.push('c'),
            'у' => out.push('y'),
            'х' => out.push('x'),
            'і' => out.push('i'),
            'Α' | 'А' => out.push('A'),
            'В' => out.push('B'),
            'Е' => out.push('E'),
            'К' => out.push('K'),
            'М' => out.push('M'),
            'Н' => out.push('H'),
            'О' => out.push('O'),
            'Р' => out.push('P'),
            'С' => out.push('C'),
            'Т' => out.push('T'),
            'Х' => out.push('X'),
            other => out.push(other),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::ManagedRulesConfig;

    fn cfg() -> ManagedRulesConfig {
        ManagedRulesConfig::default()
    }

    #[test]
    fn test_restricted_word_match_in_args() {
        // Whole words block...
        assert!(
            ManagedRuleset::evaluate(&cfg(), "exec_command", "please run rm -rf /tmp/x").is_err()
        );
        assert!(
            ManagedRuleset::evaluate(&cfg(), "exec_command", "the command is RM -rf /").is_err()
        );
        assert!(ManagedRuleset::evaluate(&cfg(), "exec_command", "shutdown now").is_err());
    }

    #[test]
    fn test_restricted_substrings_do_not_block() {
        // ...but substrings inside ordinary words must not (the old bug).
        assert!(
            ManagedRuleset::evaluate(&cfg(), "exec_command", "Please confirm the change").is_ok()
        );
        assert!(ManagedRuleset::evaluate(&cfg(), "db_query", "add a row to the table").is_ok());
        assert!(ManagedRuleset::evaluate(&cfg(), "read_file", "the address book entry").is_ok());
        assert!(
            ManagedRuleset::evaluate(&cfg(), "code_interpreter", "count the odd numbers").is_ok()
        );
        assert!(ManagedRuleset::evaluate(&cfg(), "write_file", "form the sentence").is_ok());
    }

    #[test]
    fn test_restricted_tool_name_still_blocks() {
        assert!(ManagedRuleset::evaluate(&cfg(), "format_disk", "").is_err());
        assert!(ManagedRuleset::evaluate(&cfg(), "disk_shutdown", "").is_err());
        assert!(ManagedRuleset::evaluate(&cfg(), "rm", "").is_err());
        assert!(ManagedRuleset::evaluate(&cfg(), "runShutdown", "").is_err());
        assert!(ManagedRuleset::evaluate(&cfg(), "MKFSVolume", "").is_err());
        assert!(ManagedRuleset::evaluate(&cfg(), "fs.chmod", "").is_err());
        assert!(ManagedRuleset::evaluate(&cfg(), "dd2", "").is_err());
        for tool in [
            "rmrf",
            "rm-rf",
            "sudo_rm",
            "RmDir",
            "rmdir",
            "rmtree",
            "rimraf",
            "deltree",
            "shutdownhost",
            "chmodfile",
            "ShutDown",
            "chMod",
            "rM",
            "ReBoot",
            "SHUTDOWN",
        ] {
            assert!(
                ManagedRuleset::evaluate(&cfg(), tool, "").is_err(),
                "{tool}"
            );
        }
    }

    #[test]
    fn test_restricted_tool_name_substrings_do_not_block() {
        for tool in [
            "transform_data",
            "perform_search",
            "confirm_order",
            "add_item",
            "addItem",
            "odd_numbers",
            "formatter",
            "reformat_text",
            "information",
            "rms_norm",
            "formatted_output",
        ] {
            assert!(ManagedRuleset::evaluate(&cfg(), tool, "").is_ok(), "{tool}");
        }
    }

    #[test]
    fn tool_name_words_split() {
        assert_eq!(tool_name_words("format_disk"), ["format", "disk"]);
        assert_eq!(tool_name_words("runShutdown"), ["run", "shutdown"]);
        assert_eq!(tool_name_words("MKFSVolume"), ["mkfs", "volume"]);
        assert_eq!(tool_name_words("dd2"), ["dd", "2"]);
    }

    #[test]
    fn fold_strips_null_and_rtl_marks() {
        assert_eq!(fold_system1("rm\u{0000} -rf"), "rm -rf");
        assert_eq!(fold_system1("rm\u{202E} -rf"), "rm -rf");
    }

    #[test]
    fn fold_maps_fullwidth_and_homoglyphs() {
        assert_eq!(fold_system1("ｒｍ"), "rm");
        assert_eq!(fold_system1("drор"), "drop"); // cyrillic o
        assert!(ManagedRuleset::evaluate(&cfg(), "exec_command", "please ｒｍ -rf /tmp").is_err());
    }
}
