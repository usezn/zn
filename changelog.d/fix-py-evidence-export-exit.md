### Fixed
- The Python `zn-gate evidence --export` now exits `1` when the evidence chain was changed or damaged, the same code `--verify` uses. The export is still written, and a short note on stderr says the log should not be relied on as proof. Before, it always exited `0`, so a script or CI job could not tell a changed log from a good one.
