### Fixed
- `zn vault reset` no longer says that it replaces the vault key in your keychain: the key is replaced when you run `zn unlock` to create the new vault. If an old vault file cannot be removed after the backup, the reset now stops with a message that the backup is complete, where it is, and which files are left, instead of an error half way.
