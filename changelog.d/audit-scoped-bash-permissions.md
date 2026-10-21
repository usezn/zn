### Fixed
- `zn audit` no longer reports scoped Claude Code permissions such as `Bash(bun run test:*)` or `Bash(git status:*)` as allowing any command. Only `Bash`, `Bash(*)`, a bare interpreter wildcard (`Bash(python:*)`) and prefixes that run arbitrary code (`bash -c`, `python -c`, `npm exec`) are reported. `AUDIT_RULES_VERSION` is now `2026-10-21.7`.
