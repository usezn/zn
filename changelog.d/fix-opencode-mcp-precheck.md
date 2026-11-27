### Security
- OpenCode: arguments of MCP tool calls are now checked before the call runs, as they already were for Claude Code and
  Cursor. Before, a secret placeholder or a secret value in a call to a third-party MCP server was not blocked on
  OpenCode, and personal data skipped the check. Personal data now follows the same egress setting as for Claude Code and
  Cursor (where zn would ask, OpenCode shows a block). The `secrets` server that zn installs is recognised from
  OpenCode's configuration and may still carry placeholders.
