### Fixed
- `zn-gate check` and `zn-gate doctor` refuse an option they do not know, such as `--json`, with exit code `2`. The message names the option and lists the one they take (`--hooks`). Before, the option was ignored and the plain check ran.
