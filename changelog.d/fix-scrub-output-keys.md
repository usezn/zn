### Security
- Secrets used as property names in an MCP tool output were not redacted before the model read them (only the values were); keys are now redacted like values, in the hooks, in the `sanitizeToolResult` library API (Node and Python, so `guard({maskSecrets: true})` and the MCP proxy's `sanitized_arguments` too), and keys that end up with the same text are numbered so no value is lost.
