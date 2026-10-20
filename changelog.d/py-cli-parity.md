### Fixed
- Python CLI: `report`, `reach`, `connect` and `disconnect` now say they are npm package commands and print the exact command to run, instead of a usage error. `zn-gate version` prints the version like `--version`.
- Python CLI: an unknown command prints `Unknown command: X` and `Run 'zn-gate --help' for usage.` and exits `2`, like the npm package; `scan` with a path that does not exist keeps exiting `2`.
