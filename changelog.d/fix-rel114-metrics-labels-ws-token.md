### Security
- The `tool_name` label of the `zn_tool_calls_total` metric now keeps only well-known tool names and counts every other name as `other`, so a client can no longer create an unbounded number of series or put its own strings into `/metrics`.
- `zn start` no longer prints the MCP WebSocket token. A generated token is saved to `zn-mcp-ws-token.txt` next to the audit database (readable only by you), and debug output of the security configuration hides the API key, JWT secret and token.
