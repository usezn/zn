### Fixed
- The proxy health check no longer waits for an MCP server that is stuck on a request. Such a server is reported as down after a short wait, and the other servers are reported right away.
