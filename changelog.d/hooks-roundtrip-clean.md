### Fixed
- `zn-gate hooks uninstall` now gives back the agent settings file as install found it when nothing else changed in it: a one-line JSON file keeps its format, an empty `{}` that was there before stays, and a file that install created is deleted instead of being left as `{}` (or as an empty skeleton for Cursor, Codex, Copilot and Antigravity). If you changed other settings after install, only zn's entries are removed, as before.
- zn keeps only the three newest `.bak-zn-*` backups of each agent settings file, and two backups taken in the same second no longer overwrite each other.
