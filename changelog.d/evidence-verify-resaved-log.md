### Fixed

- `zn-gate evidence --verify` no longer reports "tamper detected" for a log that only starts with a byte order mark added by an editor. It says the log was re-saved by an editor, that no record was changed, and gives a command to remove the mark. A real edit is still reported as tamper, with or without the mark. A log with Windows line endings (CRLF) still verifies and now carries a note. `--verify` never changes the log. The npm and Python packages behave the same.
