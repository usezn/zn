### Changed
- An option a command does not know now stops it with exit code 2 and the closest option it does know (`zn-gate scan --jsn` prints `unknown option --jsn; did you mean --json?`), in `scan`, `check`, `init`, `evidence`, `report` and `stats`, as `audit` and `reach` already did. Before, such a command ran as if the option had not been given: `zn-gate scan proj --json` printed the text report and exited 1. A value option without its value, such as `scan --format`, is refused too, and `--name=value` now works for them.

### Added
- `--json` is accepted as the same as `--format json` in `zn-gate scan` and `zn-gate audit`, as in `reach`, `report` and `stats`, in the npm and the Python package.

### Fixed
- `zn-gate scan --code <folder>` and `zn-gate scan --format json <folder>` scan the folder; the folder was ignored when an option came before it.
