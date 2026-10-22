### Security
- Hooks (Claude Code): the output of web fetches, MCP tools and shell commands is checked with the local rules, and when they flag text that reads like instructions the agent is told to treat it as data and to tell the user. On by default, never blocks (the first and the last 64 KiB of each output are checked); `hooks.checkToolOutputInstructions: false` turns it off.
