### Added
- Codex: `zn hooks install codex` now also registers `SessionStart` and `SubagentStart` hooks. They add a short reminder for the model (zn protects `.env` files and the vault; use `zn run` for commands that need a secret). They never block and check nothing.
