### Fixed
- Python package: `zn-gate stats` and the evidence commands no longer crash with a traceback when a local file (`stats.json`, the evidence ledger or the reach history) is nested too deeply to read. A damaged ledger line now gives the usual "damaged ledger" error.
