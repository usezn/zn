### Changed
- Python CLI: `zn-gate scan` with a path that does not exist and an unknown command now exit with `1`, as documented in the CLI reference.

### Fixed
- Python CLI: `report`, `reach`, `connect` and `disconnect` now say they are npm package commands and print the exact command to run, instead of a usage error. `zn-gate version` prints the version like `--version`.
