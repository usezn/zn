### Fixed
- `zn vault log export --otlp` printing to the terminal or a pipe now writes nothing unless the audit log is confirmed to be the one the vault verified. If the log changed in between, the command fails with the same message and stdout stays empty, as `--out` already did.
