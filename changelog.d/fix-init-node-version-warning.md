### Changed
- `zn-gate init` now says why it skips the Claude Code plugin on Node.js older than 20.19, before it installs anything: the plugin needs Node.js 20.19 or later, zn's hooks are set up instead, and Node.js 22 LTS (from nodejs.org) is the fix.
