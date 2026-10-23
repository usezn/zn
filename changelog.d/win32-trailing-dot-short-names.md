### Security
- On Windows, a protected file written with a trailing dot or space (for example `settings.json.`) or through its 8.3 short name (for example `SETTIN~1.JSO`) is now treated as the protected file. Under a protected folder (for example `.claude`, `.ssh` or `.aws`), any 8.3 short name is treated as protected, including the hash-style names Windows creates when many files share a prefix.
