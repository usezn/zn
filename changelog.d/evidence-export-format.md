### Fixed
- `zn-gate evidence --export` with an unknown `--format` now stops with exit code 2 and lists the valid formats (`jsonl` and `csv`), instead of exporting JSON Lines without a word.
