### Fixed
- `zn-gate evidence` checks `--port` (a whole number from 1 to 65535) and `--tail` (a positive whole number): a value that is not one prints a single line and exits `2` instead of being ignored, and `--ui` on a port that is already in use prints `port N is in use; choose another with --port` and exits `1` instead of a Node.js stack trace.
