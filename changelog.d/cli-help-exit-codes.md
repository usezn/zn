### Changed
- `zn-gate --help` builds the list of agents for `hooks install` from the agents zn supports, so it now includes `antigravity`, and it lists `vault team`.
- Exit codes follow one table: `0` done, `1` the command ran and found a problem, `2` wrong usage. `zn-gate` with a command it does not know, `shield` without a command and `scan` with a path that does not exist now exit `2` (they exited `1`), the same as `audit` and `reach`. The secrets commands keep `64` (wrong usage), `77` (refused) and `127` (program not found). The table is in `docs/cli.md`.
- `zn-gate unlock` on a vault that is already unlocked says so and exits `0` instead of `1`: the vault is already in the state you asked for. It still asks nothing and does nothing.
