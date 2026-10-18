### Security
- `zn audit` now hides the value of more credential flags in its reports and keeps naming the real package after them: `--passphrase`, `--bearer`, `--pass`, `--tokens`, `--keys`, `--jwt` and `--cookie`. Short flags such as `-t` and `-k` are not treated as credential flags, because they mean something else in many tools.
