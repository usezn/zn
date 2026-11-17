//! The image sanitiser: base64 data URIs in tool arguments, then the JPEG and PNG chunk walkers.
//!
//! Input: one mode byte, then the payload.
//!   0  the payload is the argument text itself (the data URI scanner sees arbitrary text)
//!   1  the payload becomes the bytes of a data URI, whatever they are
//!   2  the same, behind a JPEG signature
//!   3  the same, behind a PNG signature
#![no_main]

use base64::{engine::general_purpose::STANDARD, Engine as _};
use libfuzzer_sys::fuzz_target;
use zn::config::ManagedRulesConfig;
use zn::engine::vision::VisionEngine;

const JPEG_MAGIC: &[u8] = &[0xFF, 0xD8, 0xFF];
const PNG_MAGIC: &[u8] = b"\x89PNG\r\n\x1a\n";

fuzz_target!(|data: &[u8]| {
    let Some((&mode, rest)) = data.split_first() else {
        return;
    };
    let config = ManagedRulesConfig {
        visual_pii_redaction: true,
        ..ManagedRulesConfig::default()
    };

    let mode = mode % 4;
    if mode == 0 {
        let arguments = String::from_utf8_lossy(rest);
        let _ = VisionEngine::sanitize_multimodal(&arguments, &config);
        let _ = VisionEngine::detect_malicious_ocr(&arguments, &config);
        return;
    }

    let mut image = match mode {
        2 => JPEG_MAGIC.to_vec(),
        3 => PNG_MAGIC.to_vec(),
        _ => Vec::new(),
    };
    image.extend_from_slice(rest);

    let prefix = "{\"image\":\"data:image/png;base64,";
    let suffix = "\"}";
    let arguments = format!("{prefix}{}{suffix}", STANDARD.encode(&image));

    let _ = VisionEngine::detect_malicious_ocr(&arguments, &config);

    // Errors are fine (a timeout under load included); an accepted image must stay a well-formed
    // data URI of the same kind, never grow, and be left alone by a second pass.
    if let Ok(out) = VisionEngine::sanitize_multimodal(&arguments, &config) {
        let inner = out
            .strip_prefix(prefix)
            .and_then(|s| s.strip_suffix(suffix))
            .expect("the surrounding text is kept");
        let clean = STANDARD.decode(inner).expect("the output is valid base64");
        assert!(clean.len() <= image.len(), "the sanitised image grew");
        // Only the first two bytes: when junk follows a stripped segment, the walker keeps it as is.
        let sig = image.len().min(2);
        assert_eq!(clean.get(..sig), image.get(..sig), "the signature changed");
        if let Ok(again) = VisionEngine::sanitize_multimodal(&out, &config) {
            assert_eq!(again, out, "a second pass removed more");
        }
    }
});
