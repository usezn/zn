### Fixed
- `zn-gate check`, `doctor`, `status`, `version`, `test`, `evidence`, `logs`, `export` and `team status` refuse an option they do not know, such as `--json`, with exit code `2`. The message names the option and lists the options the command takes. Before, the option was ignored and the command ran as if it were not there.
