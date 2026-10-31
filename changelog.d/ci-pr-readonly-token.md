### Changed
- CI: the weekly Cache cleanup workflow no longer also runs when a pull request is closed, so no workflow that a pull request can edit holds a write token; the caches of closed pull requests are removed by the weekly run.
