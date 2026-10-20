### Fixed
- The secrets MCP server now answers every message of a JSON-RPC batch even if one of them fails (that message gets an error reply), and rejects a repeated `initialize` instead of renegotiating the protocol version mid-session.
