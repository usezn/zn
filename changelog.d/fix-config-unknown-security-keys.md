### Changed
- A misspelt setting inside the `security` or `audit` sections of `zn.json` is now an error: zn stops with a message that names the setting and the closest valid one, instead of only warning and running with the setting ignored. Unknown settings in other sections still produce a warning.
