### Fixed
- `zn-gate reach --history` no longer reports a file as partly scanned when the time limit passes just as the last bytes were read: a file read to the end is complete and its last line is counted. This applies to both the npm and the Python package.
- `zn-gate reach --history` checks the time limit while it scans a very long line, so one huge line no longer runs far past `--max-seconds`.
- The reach documentation now gives the time a 300 MB history takes with the Python package next to the npm one.
