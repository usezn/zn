### Security
- `zn init` no longer writes keys or tokens read from the environment (`ZN_API_KEY`, `ZN_JWT_SECRET`, `ZN_MCP_WS_TOKEN`, `ZN_DB_KEY`) into `zn.json`, so a config file that is committed or shared does not carry them; they stay in the environment. On Linux and macOS the file is now created readable by its owner only (mode 0600).
