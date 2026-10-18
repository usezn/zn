### Fixed
- `zn hooks install` for Claude Code now refuses a `settings.json` or `.mcp.json` that holds something other than a JSON object (such as `[]`, `null` or a number), or a `hooks` or `mcpServers` field that is not an object, and leaves the file unchanged. Before, the install reported success and no hooks were installed.
