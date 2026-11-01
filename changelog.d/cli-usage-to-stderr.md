### Fixed
- `zn-gate stats` and `zn-gate report` now print their usage text on standard error when the arguments are wrong (for example `--days 0`, `--since 0d` or an unknown word), like the other commands. Standard output stays empty in that case and the exit code is still 2. `--help` still prints to standard output and exits with 0.
