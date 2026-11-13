### Fixed

- `zn-gate scan` in the Python package reports a file whose read fails after the readability check (it changed during the scan, or an input/output error) as not read, so the scan is incomplete (exit code 3), like the npm package. Before, the file was counted as scanned and clean.
