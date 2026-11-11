### Fixed
- `zn-gate evidence --export` in the Python package exits `1` when the log's SHA-256 chain was changed, as `--verify` does. The export file is still written and the tamper warning is still printed.
