### Changed
- `zn-gate init` and `zn-gate check` now add the Claude Code plugin marketplace at the tag of the installed release (`claude plugin marketplace add usezn/zn@v<version>`), and the READMEs say the same, so `claude plugin update` no longer follows the default branch. The release checks fail if any `marketplace add usezn/zn` on a public page has no release tag.
