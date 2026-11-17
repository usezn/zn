### Fixed
- The experimental Rust gateway (built from `src/`, not shipped) stops with a plain error instead of a panic or an overflow when `server.channel_capacity` is 0 or huge, when the neural model cannot be loaded, or when `engine.memory_limit_mb` is too large to count in bytes.
- Every on/off environment variable of the gateway now takes `1`, `0`, `true`, `false`, `yes`, `no`, `on` or `off`, and refuses any other word at start. This includes `ZN_NEURAL_ENABLED` (a typo used to mean "on"), `ZN_NEAREST_NEIGHBOR_AUDIT`, `ZN_KMS_ALLOW_CONFIG_FALLBACK`, `ZN_KMS_RECOVER_NEW_DATA_KEY` and `ZN_FAST_BOOT` (`ZN_FAST_BOOT=0` now means off).
- `security.rate_limit_enabled` and `kms.region` (`ZN_KMS_REGION`) now take effect in the gateway. They were read but never used.

### Deprecated
- `audit.max_logs_in_memory`, `neural.classifier_threshold` and `consensus.neural_as_witness` have no effect in the experimental gateway. A settings file that sets one still loads, with a warning; `zn init` no longer writes them.

### Changed
- The gateway guide (`docs/rust-core.md`) now lists every environment variable and settings key with its meaning, default and accepted values, and explains what `ZN_ENV=production` enforces.
