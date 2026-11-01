### Fixed
- When the disk or quota is full, the messages of `uninstall`, `hooks install` (copilot, opencode, antigravity, zcode), `unlock`, `disconnect`, `vault log export --out` and `evidence` now say in plain words which file could not be written, instead of a raw system error or "a file". Node and Python give the same sentences.
- A failed write of the saved API key settings (`disconnect`, `connect`) no longer leaves an empty temporary file in `~/.zn`; the settings file itself is kept as it was.
- `check` in a container whose temporary folder is read-only (or is not a folder) now names the temporary folder and says to set `TMPDIR` to a folder you can write, instead of printing a template name with `XXXXXX`.
