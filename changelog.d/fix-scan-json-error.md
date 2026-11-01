### Fixed
- `zn-gate scan <path> --format json` on a path that does not exist now prints an error object on stdout (`{"error": {"code": "path_not_found", "message": ..., "path": ...}}`), so a script reading stdout gets JSON instead of an empty stream. The stderr message and the exit code `1` are the same in the npm and the Python package.
