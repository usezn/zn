### Security
- Claude Code and OpenCode now check the arguments of an MCP tool call before the call, as Codex, Cursor, Gemini and Antigravity already did: a call that would send a secret value or a vault placeholder to an MCP server is blocked. Run zn hooks install claude-code again to update an existing install (the plugin picks it up with the next release). OpenCode needs no reinstall.
