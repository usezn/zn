### Fixed
- The evidence log lock waits longer (10 seconds instead of 2) when the log folder is on NFS or SMB/CIFS, and `ZN_EVIDENCE_LOCK_WAIT_MS` sets the wait in both packages. An event that still cannot be written is no longer lost silently: `zn-gate stats` shows how many evidence log events could not be written (`evidenceDropped` in `--json`).
