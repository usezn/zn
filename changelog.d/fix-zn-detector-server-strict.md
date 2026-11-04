### Security
- In Claude Code, zn-gate now recognises its own detector MCP server only when it is the real launcher: `npx -y zn-gate mcp` with a registry version (or `latest` or `next`), or zn-gate's own `bin/cli.js` run by an absolute Node.js outside the project. A bare `zn` or `zn-gate` command found on the PATH, and `zn-gate@npm:`, `file:` or `github:` specs, are checked like any other server.

### Fixed
- In Claude Code, a prompt written after `--mcp-config cfg.json` is no longer read as a second config file, so zn's secrets tools keep working in that session.
