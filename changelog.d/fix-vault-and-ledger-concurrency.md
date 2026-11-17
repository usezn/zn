### Fixed
- `zn secret set NAME` without `--force` no longer replaces a secret that another terminal stored at the same moment: the vault refuses the second one with "already exists; use --force to replace it".
- `zn secret rm NAME` now fails with "is not in the vault" when the secret is already gone, instead of printing "Removed".
- When the decision log is busy, a hook now waits up to 2 seconds (as the libraries do), less when it is close to its own time limit. Events that still cannot be written are counted, and the next write adds a record "N events were not recorded (log busy)". `zn-gate evidence --verify` shows these gaps (Node and Python packages).
- A decision-log lock left by a process that no longer exists is broken at once (same computer) instead of after 10 seconds, in both the Node and the Python package.
