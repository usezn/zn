### Fixed
- `zn-gate scan` now shows clean relative paths when the folder you scan is reached through a link, for example the temporary folder on macOS (`/var` is a link to `/private/var`), instead of paths like `../../private/var/...`.
