### Security
- The shield no longer forwards a line from the agent that is not valid JSON (for example one containing `NaN`) to the MCP server unchecked. It is refused with a parse error when its request id can be read, and dropped and logged otherwise. Shadow mode still passes it on and reports it.
