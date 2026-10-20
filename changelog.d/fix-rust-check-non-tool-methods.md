### Security
- The Rust gateway now applies its managed rules to every MCP request that can carry data (such as `resources/read`, `prompts/get` and `sampling/createMessage`), not only to tool calls. Handshake, ping, list and notification messages are still forwarded unchanged.
