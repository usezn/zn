### Fixed
- When `~/.zn/config.json` is not valid JSON, `zn-gate status` and `zn-gate check` now say so, and the hook writes one warning to stderr per run. zn-gate keeps using its default settings, as before, and does not change the file.
