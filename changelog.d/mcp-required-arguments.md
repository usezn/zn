### Changed
- The local MCP servers (`zn-gate mcp` and `zn-gate secrets-mcp`) answer a tool call that leaves out a required argument with a tool error (`ZN_BAD_ARGUMENTS`) that names it. Before, `check_tool_call` and `check_tool_result` checked an empty value and reported it as safe. `secrets_http_request` no longer lists `method` as required: it defaults to `GET`, as it already did.
