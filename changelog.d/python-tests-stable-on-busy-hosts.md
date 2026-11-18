### Changed
- Python package tests no longer fail on busy or minimal hosts: the scan format comparison with the Node CLI no longer depends on npx being on the PATH, and the linear-time checks compare how time grows with input size instead of an absolute time limit.
