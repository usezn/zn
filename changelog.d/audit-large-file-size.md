### Fixed
- `zn audit` now explains an agent file over 1 MiB in its own words (the file is too large, only its first 1 MiB was checked, split it) instead of pointing at a syntax error, and still checks that first MiB. Text files get every check on it; JSON and TOML files cannot be parsed when cut, so the finding says their hooks and settings were not reviewed.
