### Fixed
- On Windows the gateway now starts MCP servers that run through a .cmd file (a bare `npx` or `uvx`): it finds them in the absolute folders of your `PATH` (never the current folder or a relative entry), and refuses an argument that `cmd.exe` would treat as a command, with a message that names the character.
