### Security
- Secrets used as property names in an MCP tool output were not redacted before the model read them (only the values were); keys are now redacted like values, and keys that end up with the same text are numbered so no value is lost.
