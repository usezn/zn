### Fixed
- `zn vault log export --otlp` reads the audit log in chunks and writes the export piece by piece, so a very large log no longer fails with a string-too-long error. The output is the same as before. A log that cannot be read gives a plain read error, never a tamper warning, and `--out` leaves no partial file when that happens.
