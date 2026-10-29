### Fixed
- OpenCode: when the zn hook cannot start (for example the Node.js it was installed with is gone), the blocked call now says so in plain words and gives the repair step (`zn-gate check`, then `zn hooks install opencode`), instead of a raw `spawn ... ENOENT` error.
