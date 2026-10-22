### Fixed
- `zn-gate scan`, `check`, `status` and `evidence` now refuse an option they do not know, an option without its value and an extra word. They exit `2` with a one-line usage, as the command line reference says. `evidence --export --format xml` exits `2` too.
- The `scan` text report no longer says `PASSED - NO THREATS DETECTED` or `Clean workspace` (or, in the Python package, "are clean!") when a folder could not be read. It shows `Audit Result : INCOMPLETE - some folders could not be read`. The exit code is unchanged.
- `zn-gate scan --format json <folder>` scans that folder (the folder after an option used to be ignored).
- `zn-gate secret --help`, `env --help`, `hooks --help` and `scan --help` print their own short usage instead of the general help.
- `zn unlock` on a vault that is already unlocked says so and exits `0`, like `lock` does when the vault is not unlocked.
- `zn secret set NAME` for a name that is already stored exits `1` instead of `64`, and the message still points to `--force`.
- The command line reference now says how a hook answers: a blocked call exits `0` with the deny answer of its agent, and `2` only when the event cannot be read.
- `zn-gate --help` now describes `status` as showing the engine configuration and whether the cloud check is on; it never opened a connection.
