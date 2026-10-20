### Fixed
- The Codex plugin's `hooks.json` now installs the same hook events and matchers as `zn hooks install codex`: `PermissionRequest`, `SessionStart`, `SubagentStart` and `Stop` were missing, and `PreToolUse` did not cover MCP tool calls. A test fails when the two drift apart.
