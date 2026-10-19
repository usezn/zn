### Added
- `zn-gate check` reports Codex as not protected when your `config.toml` switches one of zn's hooks off with `[hooks.state]` (`enabled = false`). It already did so for `[features] hooks = false` and for managed-only hooks. The Python package has no `check` command.
