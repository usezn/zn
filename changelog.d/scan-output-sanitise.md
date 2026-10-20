### Security
- `zn-gate scan` no longer prints raw control characters from folder and file names in its "Not scanned" and "Directories not scanned" lists. A folder name with terminal escape sequences could repaint the screen; the characters now appear escaped (for example `\x1b`), in both the Node.js and Python packages.

### Fixed
- `zn-gate scan` and `zn-gate audit` now list `.idea`, `.venv`, `venv`, `__pycache__` and `.eggs` under the directories they do not read, with the reason, instead of skipping them silently, so an agent file kept in one of them does not go unnoticed.
