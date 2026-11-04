### Fixed
- A `~/.zn/config.json` saved with a byte order mark, as Windows PowerShell 5.1 and older Notepad can write it, is now read normally. Before, zn ignored the whole file, so hook options and the cloud key marker were not applied.
