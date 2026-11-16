### Fixed
- The Python `zn-gate` CLI takes only full long option names. A shortened name such as `scan --allow` is now an error (exit 2) instead of being read as `--allow-partial`, which could exit 0 with files that were not read.
