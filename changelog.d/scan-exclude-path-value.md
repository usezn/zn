### Fixed
- `zn-gate scan --exclude` takes folder names. A value that is a path, such as `--exclude fixtures/sample.md`, matched no folder and was ignored in silence, so the folder was still scanned. It is now refused with exit `2`, and the message names the value. Pass the folder name instead (`--exclude fixtures`).
