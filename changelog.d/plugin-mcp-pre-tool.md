### Security
- Claude Code plugin: the PreToolUse hook also matches MCP tools (mcp__*), the same as zn hooks install claude-code, so MCP calls are checked before they run once the plugin uses a zn-gate release with that check.
