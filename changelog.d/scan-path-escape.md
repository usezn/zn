### Security
- `zn-gate scan` text output (Node.js and Python packages) now shows control characters in file paths as `\x1b`-style escapes everywhere, including the location of each finding and the "No files were scanned" line, so a file name in a repository cannot write terminal sequences.

### Changed
- `zn-gate scan` names what each skipped folder is: `.idea` is "editor settings", `.venv` and `venv` are "virtual environment", `__pycache__` is "Python cache" and `.eggs` is "Python build files", instead of "build output".
