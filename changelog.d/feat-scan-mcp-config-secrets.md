### Added
- `zn-gate scan` (npm and PyPI packages) and `zn audit` (ZNA011) find keys and passwords written in plain text in MCP server configs (`.mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`, `.codex/config.toml`, `claude_desktop_config.json` and similar): a value under a name such as an API key, token, password or `Authorization` header, the value after a credential flag in `args`, and a key in a server URL. References such as `${NAME}` and `__ZN_NAME__` are not reported. The report shows the kind, the name that holds the value, the file and the line, never the value, and says how to move it into the vault or an environment variable.
- `zn-gate scan --include-home` also checks your own MCP configs (Claude Desktop, Claude Code, Cursor, Codex, Gemini, Antigravity, OpenCode, Amazon Q).
- In MCP config files, a credential that a provider rule used to report is now reported as `secret:mcp_config`, so code scanning closes those alerts and opens them again under the new rule id.
### Fixed
- `zn-gate scan` (npm package) now reads `.vscode/mcp.json`, which it skipped with the rest of the `.vscode` folder.
