### Security
- The folders that hold the KMS data key, the generated MCP WebSocket token and the vector store are created owner-only (mode 0700 on Unix), and an existing one that another account can write to, or that belongs to another user, is refused with a message instead of being used.
