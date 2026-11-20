### Changed
- `zn-gate check` and `zn-gate status` warn that odd-numbered Node.js releases past their support (19, 21, 23 and 25) are end-of-life and get no security fixes. The end-of-life warning now says the line is unsupported, apart from the warning for a patch that is missing.

### Fixed
- The Claude Code plugin refuses a Node.js older than 20.19 with one plain line that names the version it needs, instead of a loader message.
