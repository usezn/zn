### Fixed
- Config backups: zn now prunes only the backups it made itself (names ending in a timestamp), never other files that merely start with the same name. `reach --history` (npm and Python) now finds a secret that falls across the cut of a very long line, and `vault log export --otlp` writes the whole export even when the disk takes it in pieces, checking the temporary copy before using it.
