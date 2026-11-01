### Fixed
- `zn run` now doubles a trailing backslash (and any backslashes before a double quote) when it starts a `.cmd` or `.bat` file on Windows, so an argument such as `C:\dir\` reaches the program unchanged instead of being read as an escaped quote.
