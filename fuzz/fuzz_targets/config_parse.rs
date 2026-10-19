//! Configuration text read from disk: arbitrary bytes must never panic the parser or the checks after it.
#![no_main]

use libfuzzer_sys::fuzz_target;
use zn::config::{normalize_credential, ZnConfig};

fuzz_target!(|data: &[u8]| {
    if let Ok(config) = serde_json::from_slice::<ZnConfig>(data) {
        let _ = config.validate();
        let _ = config.is_neural_blocking();
        let _ = config.paranoia_threshold_multiplier();
        let _ = config.paranoia_classifier_threshold();
    }
    if let Ok(text) = std::str::from_utf8(data) {
        let _ = normalize_credential(Some(text.to_string()));
    }
});
