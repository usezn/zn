### Fixed
- `zn-gate check` and `zn-gate status` now warn about Node.js 23, 25 and the other odd-numbered lines older than the newest supported one: they never get long-term security fixes, so they are reported as end-of-life like Node.js 18 and 20.
- `-V` and `--version` now print the version only before the command in the npm package, as in the Python package. `zn-gate scan . -V` used to print the version and skip the scan; now `-V` after a command is an unknown option (exit 2) in both packages.
