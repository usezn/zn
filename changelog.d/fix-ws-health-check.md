### Fixed
- WebSocket MCP connections are now health-checked with a ping that must be answered within a few seconds, so a dead or unresponsive server is reconnected instead of being reported as healthy.
