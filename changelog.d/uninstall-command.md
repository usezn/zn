### Added
- `zn-gate uninstall` removes zn-gate in one step. It lists what it found (the Claude Code plugin, zn's hooks for each agent, MCP servers wrapped by `init --wrap-mcp`), asks you to confirm in your own terminal, then removes them and runs `zn-gate check`. The vault is only deleted if you confirm that separately, and `--dry-run` shows the list without changing anything. `zn-gate --help` now lists it and `hooks uninstall`.

### Changed
- The README and the CLI reference now say what `init --revert` really does (it puts back saved MCP configs) and point to `zn-gate uninstall` for removing the rest.
