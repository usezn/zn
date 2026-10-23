### Fixed
- `zn-gate shield`: when a batch of messages from the MCP server has to be dropped, every request of the client it answers now gets its own error, including requests such as `resources/read` and `prompts/get`, so the client does not wait for an answer that will not come.
