### Fixed
- When the cloud gate answers from its rules alone because its model was unavailable, `analyze` now marks the result with `degraded: true` and `degraded_reason` (Node and Python), and `zn-gate analyze` prints a one-line warning on stderr. The verdict itself is unchanged.
