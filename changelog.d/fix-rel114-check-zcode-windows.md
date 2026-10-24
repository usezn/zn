### Fixed
- `zn-gate check` on Windows now recognises the hook that `zn hooks install zcode` writes, so it no longer reports ZCode as not set up (or never warns when `hooks.enabled` is off) while the hook is installed and blocking.
