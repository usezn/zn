### Fixed
- The MCP servers (`zn-gate mcp` and `zn-gate secrets-mcp`) no longer repeat client input in their error replies. A line that is not valid JSON gets a bare `-32700` "Parse error" with no extra data, and an unknown method or tool name is reported without being repeated. A request that is not a JSON object gets `-32600` "Invalid Request".
