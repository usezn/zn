### Security
- Experimental Rust gateway (not distributed): the Rust gateway no longer prints secrets when its settings are formatted for debugging: the audit encryption key, the SIEM token, the webhook URL (only scheme and host are kept) and the SIEM endpoint are shown as redacted. The batch worker no longer logs the text of each item at INFO level, only its length, at DEBUG level.
