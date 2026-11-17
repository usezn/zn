//! Prompt, SQL and LFI guards, and the folding that runs before them: tool names and arguments are untrusted text.
//!
//! Input: one flag byte (which managed rules are on), then the tool name, a newline and the arguments.
#![no_main]

use libfuzzer_sys::fuzz_target;
use zn::config::ManagedRulesConfig;
use zn::engine::rules::{fold_system1, fold_system1_spaced, is_invisible, ManagedRuleset};
use zn::lfi_guard::{contains_lfi, detect_lfi};
use zn::prompt_guard::{contains_prompt_injection, detect_prompt_injection};
use zn::sql_guard::{contains_sql_injection, detect_sql_injection};

fuzz_target!(|data: &[u8]| {
    let Some((&flags, rest)) = data.split_first() else {
        return;
    };
    let text = String::from_utf8_lossy(rest);
    let (tool, args) = text.split_once('\n').unwrap_or(("", &text));

    let config = ManagedRulesConfig {
        pii_redaction: flags & 1 != 0,
        lfi_protection: flags & 2 != 0,
        sql_injection: flags & 4 != 0,
        prompt_injection: flags & 8 != 0,
        restricted_commands: flags & 16 != 0,
        visual_pii_redaction: flags & 32 != 0,
    };
    let _ = ManagedRuleset::evaluate(&config, tool, args);

    // The quick check and the detailed check agree.
    assert_eq!(contains_prompt_injection(&text), detect_prompt_injection(&text).is_attack);
    assert_eq!(contains_sql_injection(&text), detect_sql_injection(&text).is_attack);
    assert_eq!(contains_lfi(&text), detect_lfi(&text).is_attack);

    // Folding: no invisible character survives, and a second fold changes nothing.
    let folded = fold_system1(&text);
    let spaced = fold_system1_spaced(&text);
    assert!(!folded.chars().any(is_invisible));
    assert!(!spaced.chars().any(is_invisible));
    assert_eq!(fold_system1(&folded), folded);
    assert_eq!(fold_system1_spaced(&spaced), spaced);
    // The spaced view keeps one character where the plain view drops it.
    assert!(spaced.chars().count() >= folded.chars().count());

    // The guards also run on the folded text in the engine.
    let _ = detect_prompt_injection(&folded);
    let _ = detect_prompt_injection(&spaced);
    let _ = detect_sql_injection(&folded);
    let _ = detect_lfi(&folded);
});
