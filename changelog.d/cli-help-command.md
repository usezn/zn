### Fixed
- `zn-gate help` now prints the same help as `--help` and exits `0`, in both the npm and the Python package. `zn-gate help <command>` prints that command's own help when it has one, and the general help otherwise. Before, `help` was refused as an unknown command (npm, exit `1`) or as a note (Python, exit `2`).
