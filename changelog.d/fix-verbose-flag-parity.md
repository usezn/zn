### Fixed
- The Python package now accepts `--verbose` on `analyze`, `scan` and `status`, like the npm package. It is the same switch as `ZN_VERBOSE=1`; before, these commands exited `2` with an "unrecognized arguments" error, so a script written for one package failed on the other.
