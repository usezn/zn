### Fixed
- When `~/.zn/config.json` is not valid JSON, `zn-gate status` and `zn-gate check` now say so, and the hook writes one warning to stderr per run. zn-gate keeps using its default settings, as before, and does not change the file.
- `zn-gate connect`, `zn-gate disconnect`, and `zn-gate stats share on|off` now refuse to write when `~/.zn/config.json` exists but is not valid JSON. They exit with `1`, explain why, and leave the file byte for byte as it was. Before, they overwrote it and lost its settings.
