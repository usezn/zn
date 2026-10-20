### Fixed
- `zn-gate unlock`, `zn-gate lock`, `zn-gate vault` and `zn-gate env shadow` print their own usage and flags with `--help`, instead of the general help.
- `zn-gate unlock` on a vault that is already unlocked says so at once, without asking for the passphrase.
