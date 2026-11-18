### Fixed
- The Codex plugin now checks MCP tool calls (`mcp__*`) before they run and registers the `PermissionRequest` hook, as `zn hooks install codex` does. Until now the plugin's `PreToolUse` hook covered only `Bash` and `apply_patch`, so an MCP call and the approval prompt for one were not checked.
