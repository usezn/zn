### Fixed
- The Node CLI now accepts `--option=value` for the options of `zn-gate scan` and `zn-gate analyze`, as the Python CLI already did, instead of refusing it with "give the value as the next argument". `--option=value` and `--option value` read the same value, including an empty one (`--format=`) and a value that contains an equals sign.
