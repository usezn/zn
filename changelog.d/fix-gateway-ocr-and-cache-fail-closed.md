### Fixed
- The experimental Rust gateway refuses a message that carries an image when `visual_pii_redaction` is on and the OCR cannot run (tesseract missing, failing or too slow), instead of letting it through unchecked. The cause is logged once.
- The experimental Rust gateway no longer answers a tool call from its result cache before the rules, policies and other checks run; every call goes through all checks.
