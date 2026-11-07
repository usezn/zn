### Fixed
- The Rust scrubber now masks AWS access key ids (AKIA, ASIA, ABIA and ACCA prefixes), matching the Node and Python scrubbers. Edge cases (end of text, mid-line, inside a longer word) are covered by tests.
