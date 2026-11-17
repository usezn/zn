### Fixed
- `zn-gate scan` (npm) no longer drops a file or folder it could not inspect. A folder whose path was too long for the system to read was skipped silently and the scan said "PASSED"; it is now listed under "Directories not scanned" with the cause (`cannot be read (path too long)`) and the scan exits `3`, as the Python version already did. The advice under the list now matches the cause instead of always pointing to permissions.

### Added
- `zn-gate scan` (npm and Python) says how many links inside the folder it did not follow: a `Links not followed: N` line in the text report and a `links_not_followed` count in `--format json`. The exit code does not change.
