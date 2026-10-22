### Security
- Claude Code now checks MCP tool calls before they run, as the other agents already did: a secret value or placeholder in the arguments is blocked, and personal data (such as an email address) asks you to approve the call. Run `zn hooks install claude-code` again to update an existing install.
