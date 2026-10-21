### Fixed
- `zn-gate scan` (Node.js) lists a folder it cannot read instead of skipping it in silence, as the Python package does, and no longer says "PASSED - NO THREATS DETECTED" when it read no files: the summary says `NOTHING SCANNED`.
