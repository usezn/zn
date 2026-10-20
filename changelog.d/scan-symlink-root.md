### Fixed
- `zn-gate scan` now follows a symbolic link given as the folder or file to scan, instead of scanning nothing and reporting a clean result. Links found inside the folder are still not followed.
- `zn-gate scan` now says "No files were scanned in <path>" (a warning in the github format, a `warning` field in JSON) when it finds nothing to scan, so an empty result no longer looks like a clean one. The exit code stays 0.
