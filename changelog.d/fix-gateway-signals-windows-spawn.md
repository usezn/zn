### Fixed
- Stopping the gateway with Ctrl+C or `SIGTERM` now stops the MCP servers it started instead of leaving them running, and exits with `130` or `143`. The request in progress finishes first, so the audit log keeps its last line.
- On Windows the gateway now finds MCP servers started with a bare `npx` or `uvx` (a `.cmd` file) on your `PATH`, and refuses to pass them an argument that `cmd.exe` would treat as a command, with a message that names the character.
