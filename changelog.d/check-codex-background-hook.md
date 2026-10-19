### Fixed
- `zn-gate check` reports Codex as not protected when zn's hook is set to run in the background (`async`) in `hooks.json` or `config.toml`, because a background hook cannot block anything.
