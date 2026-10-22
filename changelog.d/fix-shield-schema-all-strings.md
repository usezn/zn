### Security
- The MCP shield now checks every string of a tool's input and output schema (property names, `required` entries, `pattern`, `format`, `$ref` and `x-` extension keys and values), not only descriptions and default values. A tool whose schema carries a prompt injection in one of them is blocked as a whole, within the same depth and size limits.
