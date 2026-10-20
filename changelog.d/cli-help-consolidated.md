### Fixed
- `zn-gate <command> --help` prints that command's own short help, with exit code `0`, for every command and subcommand (`vault`, `team`, `hooks`, `secret`, `env`, `scan`, `evidence`...) instead of the general help. `zn-gate vault log export --help` now exits `0` (it exited `2`). `zn-gate` with no arguments prints a five line start.
- `zn-gate --help` shows `scan [path]` (the folder is optional), and `zn-gate vault --help` lists `reset` and `team`.
### Changed
- `zn-gate scan`, `check`, `init`, `status`, `evidence`, `report` and `stats` refuse an option they do not know and exit `2`, with a suggestion when one is close.
