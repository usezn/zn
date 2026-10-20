### Fixed
- `zn-gate scan` now detects text saved as UTF-16 without a byte order mark, little- or big-endian, from its NUL bytes and scans it, so a secret in such a file is reported. When the byte order cannot be told, the file is listed under "Not scanned" with the reason "unclear text encoding".
