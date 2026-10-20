### Security
- The hooks now also refuse writes to the files where an agent keeps its MCP servers and permissions: a project `.mcp.json`, `~/.claude.json`, Claude Code's managed settings (`managed-settings.json`, `managed-settings.d`, `managed-mcp.json`) and Cursor's `mcp.json` and `cli.json`. Reading them is still allowed.
