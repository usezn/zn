//! Prompt-injection and SQL-injection detectors: arbitrary text must never panic or take long, and the
//! quick check must agree with the detailed one.
#![no_main]

use libfuzzer_sys::fuzz_target;
use std::time::{Duration, Instant};
use zn::prompt_guard::{contains_prompt_injection, detect_prompt_injection};
use zn::sql_guard::{contains_sql_injection, detect_sql_injection};

fuzz_target!(|data: &[u8]| {
    let Ok(text) = std::str::from_utf8(data) else {
        return;
    };
    let started = Instant::now();

    let prompt = detect_prompt_injection(text);
    assert_eq!(prompt.is_attack, contains_prompt_injection(text));
    assert_eq!(prompt.is_attack, prompt.matched_pattern.is_some());

    let sql = detect_sql_injection(text);
    assert_eq!(sql.is_attack, contains_sql_injection(text));
    assert_eq!(sql.is_attack, sql.matched_pattern.is_some());
    if let Some(position) = sql.position {
        assert!(position <= text.len(), "match position out of range");
    }

    assert!(
        started.elapsed() < Duration::from_secs(5),
        "detection took too long"
    );
});
