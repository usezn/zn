### Fixed
- Python: `zn-gate evidence --export` with no records says so and suggests running a check first. A missing path given to `zn-gate scan` now says what to do, and the text report of a scan with unreadable files gives the next step.
- Python: `zn-gate test <path>` says that it checks the text you typed, not the file, and points to `zn-gate scan`.
- Python: `zn-gate analyze` always prints JSON, as the documentation says. The `--json` flag is still accepted, so existing scripts keep working.
