### Fixed
- `zn start`: a tool call for an MCP server that was skipped when the servers file was loaded (command not allowed, or neither a command nor a url) is now refused with the reason, instead of being passed on as allowed. The start-up warnings list those servers.
- `zn start` stops with a plain error when the Management API port is already in use (and says how to pick another port), instead of running on without the API.
