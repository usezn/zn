### Fixed
- `zn-gate scan` (Python) now lists a file it could not read under "Not scanned" instead of counting it as clean, and it reads text saved as UTF-16 without a byte order mark (LE and BE). A file whose UTF-16 byte order cannot be told is reported as not scanned.
