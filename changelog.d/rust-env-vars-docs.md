### Fixed
- The Rust gateway now applies `ZN_KMS_REGION` when the config file has a `kms` section; before, the variable only worked without one. An environment variable that does not parse (for example `ZN_NEURAL_ENABLED=maybe` or `ZN_PORT=abc`) is now reported with a warning at start and the setting keeps its value from the file or its default.

### Changed
- Docs: the Rust gateway page lists every `ZN_*` environment variable with its config key, default and effect.
