### Changed
- Claude Code no longer asks about personal data in calls to zn's own detector server (`analyze_prompt`, `check_tool_call`, `check_tool_result`) when it is the user-scope `zn-gate` or `zn` entry that runs a Node.js and zn-gate's own `bin/cli.js`, both by full path and outside the project. A secret in the call is still blocked. An `npx` entry, a bare `zn` or `zn-gate` command, `file:`, `github:` and `npm:` specs, a project-defined server with the same name and every other server are checked as before, so personal data sent to them is still asked about. If you turn on the optional cloud check, the text of an `analyze_prompt` call, personal data included, goes to zn's API by your choice.

### Security
- In Claude Code, a server with the same name in the organization's `managed-mcp.json` or passed with `--mcp-config` (Linux) now counts like a project entry, so zn's own servers are not trusted when something else redefines them.
- `npx` is no longer trusted by name: it prefers a `zn-gate` that the project carries in `node_modules` and reads the project's `.npmrc` registry, so an `npx` entry is checked like any other server.

### Fixed
- In Claude Code, a prompt written after `--mcp-config cfg.json` is no longer read as a second config file, so zn's secrets tools keep working in that session.
