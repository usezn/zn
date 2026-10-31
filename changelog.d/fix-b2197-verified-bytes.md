### Fixed
- `zn vault log export --otlp` with the vault unlocked now checks that the audit log it reads is byte for byte the one the vault verified. If a record was written in between, the command exits with an error and says so: with `--out` no file is written, and output already printed to standard output must be discarded. `--unverified` is now listed in the command help and in the Team docs.
