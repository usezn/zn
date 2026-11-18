### Fixed
- `zn-gate init --wrap-mcp`, `--dry-run`, `--shadow` and `--revert` now refuse an argument they do not know and exit `2`, as plain `zn-gate init` already did. Before, the extra argument was ignored and the command exited `0`, so a typo could look like a success. Nothing is read or changed when an argument is refused.
