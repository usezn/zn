### Fixed
- `zn-gate` no longer prints a stack trace when its output is piped into a command that closes early, such as `zn-gate check | head -1`. It still exits with the status it would have had.
