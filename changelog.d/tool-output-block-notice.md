### Changed
- When the library API withholds a tool output that looks like a prompt injection (Node.js `sanitizeToolResult`, Python `sanitize_tool_result` and the LangChain callback), the replacement text now says the output was blocked, tells the model not to follow instructions inside it, and asks it to tell the user. It starts with `[BLOCKED BY ZN-GATE:` instead of `[REDACTED BY ZN-GATE:`.
