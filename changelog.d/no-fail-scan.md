### Added
- `zn-gate scan --no-fail` in the npm CLI. It prints the full report (findings and anything not read are still listed) and always exits `0`, the same as the Python `scan --no-fail`, so a CI job that only wants a report can use either CLI.
