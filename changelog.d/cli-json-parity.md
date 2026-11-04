### Fixed
- `zn-gate analyze --json` is accepted by the npm package too, as it already was in the Python package. The output is JSON either way, so the flag changes nothing. Before, the npm package refused it with exit 2.
