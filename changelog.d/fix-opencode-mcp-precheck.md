### Security
- OpenCode: arguments of MCP tool calls are now checked before the call runs, as they already were for Claude Code and
  Cursor. Before, a secret placeholder, a secret value or personal data in a call to a third-party MCP server was not
  blocked on OpenCode. The `secrets` server that zn installs is recognised from OpenCode's configuration and may still
  carry placeholders.
