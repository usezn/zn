### Fixed
- `zn scan` lists its findings sorted by file path, then by line, in every format (text, JSON and GitHub), so the same tree gives the same output on any filesystem. Before, the order followed the order the filesystem returned the files, and a private key that starts at line 1 could be listed after a finding at line 4 of the same file. The counts and exit codes are unchanged.
