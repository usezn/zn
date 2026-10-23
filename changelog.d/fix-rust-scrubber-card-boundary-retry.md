### Fixed
- The Rust scrubber no longer skips a card number, SSN or phone number that follows a rejected candidate, such as a card number written right after an IBAN-like token. It now matches what the Node scrubber redacts.
