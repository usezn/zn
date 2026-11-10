### Added

- `zn-gate check` now prints a note under an agent whose installed version is inside the affected range of a published security advisory (Claude Code before 2.0.65, Codex CLI 0.23.0 and earlier), with the fixed version and the advisory link. It uses a table shipped in the package and sends nothing over the network. `check --json` has an `advisories` array per agent. The exit code does not change.
