### Fixed
- The gateway no longer buffers an unbounded reply line from an upstream MCP server over stdio. A line over 16 MiB is dropped as it streams in, and the client gets a "Response too large" error for its request.
