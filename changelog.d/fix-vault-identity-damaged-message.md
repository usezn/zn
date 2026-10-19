### Fixed
- When the vault key file is damaged, `zn unlock` now says the file looks damaged and to restore it from a backup instead of resetting, rather than suggesting a wrong passphrase. A real wrong passphrase keeps its message.
