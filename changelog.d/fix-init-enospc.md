### Fixed
- `zn-gate init --wrap-mcp` and `zn-gate init --revert` now exit with `1` when a config cannot be changed (for example a full disk), name the file in a plain sentence, and leave no temporary file behind. Before, they exited with `0` and printed the raw system error.
