### Fixed
- The PII scrubber now masks American Express card numbers written in the 4-6-5 grouping (`3782 822463 10005` or `3782-822463-10005`) in the Node.js, Python and Rust engines, after the same Luhn check as other cards. Numbers that mix separators, fail the checksum or do not start with 34 or 37 are left alone.
