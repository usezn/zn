### Security
- Claude Code and ZCode: a call to an MCP server whose name begins with `secrets_` (for example `secrets_` or `secrets__x`) is no longer taken as a call to zn's own `secrets` server, so a placeholder sent to it is checked and blocked. A call counts as zn's only when the tool is exactly one of the tools zn's server offers.
