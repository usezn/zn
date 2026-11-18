### Fixed
- The Claude Code plugin is moved with `claude plugin marketplace remove usezn`, `claude plugin marketplace add usezn/zn#vX.Y.Z` and `claude plugin install zn-gate@usezn`, as the upgrade guide says. The hook message no longer suggests `claude plugin update`, which keeps the pinned release.
- `zn check --help` and `zn env --help` print their own usage instead of the general help.
- The "no supported coding agent" message lists GitHub Copilot CLI and Gemini CLI.
