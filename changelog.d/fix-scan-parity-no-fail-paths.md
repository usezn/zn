### Fixed
- `zn-gate scan --no-fail` works in the Node.js package too: the report is printed and the exit code is 0 even when something is found, as in the Python package.
- `zn-gate scan --format json` in the Python package shows each `file` relative to the current directory, as the Node.js package does, instead of the path as given.
