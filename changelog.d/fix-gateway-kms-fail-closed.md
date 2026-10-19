### Fixed
- The gateway no longer falls back to the configured key silently when the KMS key cannot be fetched: it refuses to start, unless `kms.allow_config_fallback` is set to `true`, in which case it starts with a warning.
