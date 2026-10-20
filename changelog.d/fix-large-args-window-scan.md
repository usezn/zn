### Security
- Tool-call arguments over 256K characters are now checked in full, in overlapping windows, in `checkToolCall` and in the MCP shield. Before, only the start and the end were checked and the call was allowed, so flagged text in the middle went through. An argument too large to check in full (over 2 MiB) is now blocked with the reason `size:truncated`.
