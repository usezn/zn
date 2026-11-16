### Fixed
- `zn-gate reach --history` no longer reports a file as partly scanned when the time limit passes just as the last bytes were read: a file read to the end is complete and its last line is counted. This applies to both the npm and the Python package.
- `zn-gate reach --history` checks the time limit while it scans a very long line, so one huge line no longer runs far past `--max-seconds`.
- The reach documentation now gives the scan speed of the Python package (about 3.6 MB per second, against about 62 MB per second for npm, measured on a 192 MB history) and how much history each package covers within the default time limit.
