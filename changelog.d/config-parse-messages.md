### Fixed
- When an agent settings file or MCP config cannot be read as JSON, zn-gate now says why in one plain sentence: the file has comments (JSONC), starts with a byte order mark, or is not valid JSON at a given line. It also says the file was left unchanged and what to do. Before, `zn hooks install` and `zn-gate init --wrap-mcp` printed the raw parser error.
- `zn-gate init --wrap-mcp` now wraps an MCP config that starts with a byte order mark (for example one saved by Notepad). The mark is kept when the file is written, and `--revert` restores the original bytes.
