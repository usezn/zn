### Security
- In Claude Code, zn-gate now trusts its own MCP servers only when nothing else redefines them: a server with the same name in the organization's `managed-mcp.json` or passed with `--mcp-config` (Linux) counts like a project entry, and anything else is checked like any other server, so personal data sent to it is still asked about.

### Changed
- Claude Code no longer asks about personal data in calls to zn's own detector server (the `zn-gate` or `zn` MCP server registered at user scope that runs `zn-gate mcp`, such as `analyze_prompt`). The server is recognised from your Claude Code MCP configuration, not from its name, so a project-defined server with the same name is still asked about. The vault server and every other server are asked as before.
