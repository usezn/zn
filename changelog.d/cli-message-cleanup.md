### Fixed
- When your secret vault is locked, `zn vault verify`, `zn team join` and `zn team sync` now say how to unlock it once ("vault is locked; run `zn unlock`") instead of twice.
- When a hook cannot read what the agent sent, the message now names the agent (for example `zn hooks install cursor`). For the Claude Code plugin it tells you to update or reinstall the plugin instead.
- `zn-gate -v` now prints the version, like `-V` and `--version`.
