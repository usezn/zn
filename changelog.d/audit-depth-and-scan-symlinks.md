### Fixed
- `zn audit` no longer stops silently at 64 directory levels. A folder nested deeper is now reported (ZNA020, high) and the report is marked as truncated, so an agent config buried that deep can no longer hide behind a clean result. The 50,000-entry and 64-level limits are now described in the audit docs.
- `zn-gate scan` now lists symbolic links it does not follow as not scanned ("not a regular file"), the same as the Python scan.
