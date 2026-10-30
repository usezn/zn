### Fixed
- `zn vault log export --otlp` with the vault unlocked now checks that the audit log it reads is byte for byte the one the vault verified. If a record was written in between, nothing is exported and the command says so. `--unverified` is now listed in the command help and in the Team docs.
