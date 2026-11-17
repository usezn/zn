### Fixed
- `zn-gate mcp` no longer buffers a stdin line without a limit. A line over 32 MiB (lowerable with `ZN_MCP_MAX_LINE_BYTES`) is dropped as it is read, the server answers once with a JSON-RPC `Invalid Request` error, and the next message is served as usual.
