### Fixed
- `zn-gate pins approve` now refuses, with exit code 2, when its input ends before the server key is typed. Before, it exited 0 without approving anything and without a message.
