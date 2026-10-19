### Fixed
- On Node.js before 20.12, `zn-gate check` now says that the Claude Code plugin cannot run there and how to fix it (install the current LTS from nodejs.org, or use zn's hooks), and the Node.js version the plugin needs is defined in one place for `init` and `check`.
