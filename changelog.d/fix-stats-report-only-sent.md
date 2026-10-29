### Fixed
- `zn-gate stats` no longer says "Shared pseudonymous counts for <day>" when the upload failed. Only the days that were really sent are printed and listed in `sent_days` of `--json`; the others are counted in `send_failed`.
- A day of shared counts that failed to upload is tried again on the next run, even when a later day was sent.
