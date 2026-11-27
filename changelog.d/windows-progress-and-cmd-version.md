### Fixed
- `zn-gate check` now shows the version of an agent installed with npm on Windows (for example OpenCode, which npm installs as `opencode.cmd`), so the newer or older than tested warning appears instead of `version: not found`.

### Changed
- On Windows, `zn hooks install`, `zn hooks uninstall`, `zn env shadow` and the first `zn unlock` print one short line before the steps that take several seconds (file permissions and Credential Manager), so they no longer look stuck. Setting a private permission list and checking it now share one PowerShell start, which saves one start per folder; the result is checked as before.
