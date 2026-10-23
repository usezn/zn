### Fixed
- The Rust scrubber now also redacts a secret or personal value that was split by an invisible character (zero-width, soft hyphen, variation selector, tag character) or by a wrapped line break, as the Node.js scrubber does. The redaction covers the original text, including the split.
