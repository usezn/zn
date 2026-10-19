### Fixed
- `zn unlock`, `zn lock`, `zn vault` and `zn env shadow` look for `--help` only before a lone `--`, as the other commands do. An argument after `--` belongs to the command it runs and no longer prints the vault help.
