### Fixed
- `zn-gate shield`: when a batch of messages from the MCP server has to be dropped, every request of the client it answers now gets its own error, including requests such as `resources/read` and `prompts/get`, so the client does not wait for an answer that will not come.
- `zn-gate shield`: a single message from the MCP server that has to be dropped now gets an error only when it answers a request the client actually sent.
