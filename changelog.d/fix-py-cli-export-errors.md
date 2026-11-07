### Fixed
- Python: `zn-gate evidence --export --output` prints a plain message with the path and the next step when the file cannot be written (missing folder, read-only folder), instead of a traceback. It exits 1.
