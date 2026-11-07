### Fixed
- `zn-gate scan` and `zn-gate analyze` now refuse an unknown option with exit 2. The message names the option and lists the options the command takes. Before, `scan` silently ignored it and `analyze` reported "please provide text" and dropped the text that followed it.
- `zn-gate analyze -- "<text>"` analyzes text that starts with `--`.
- `zn-gate scan` now audits the folder given after its options (for example `scan --format json ./folder`), not the current folder.
