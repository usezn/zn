# Google Antigravity

Set up zn-gate in Google Antigravity in two minutes: add it as an MCP server, and what zn-gate does not cover there yet.

## Quick start (no coding needed)

1. **Check that Node.js is installed.** Open a terminal (in most editors: menu **Terminal → New Terminal**; or your computer's Terminal app), type `node --version` and press Enter. If you see a version number (18 or later), go on. If you see "command not found", install the **LTS** version from [nodejs.org](https://nodejs.org/) and restart Antigravity.
2. At the top of the agent panel, open the **…** menu → **MCP Servers** → **Manage MCP Servers** → **View raw config**. (This is the file `~/.gemini/antigravity/mcp_config.json`, or `~/.gemini/config/mcp_config.json` in some versions, where `~` is your user folder, for example `C:\Users\you` on Windows.)
3. Paste this:

   ```json
   {
     "mcpServers": {
       "zn-gate": {
         "command": "npx",
         "args": [
           "-y",
           "zn-gate",
           "mcp"
         ]
       }
     }
   }
   ```

   If the file already has a `"mcpServers"` section, add only the `"zn-gate": {...}` part inside it.
4. Save the file and restart Antigravity.

Status: these steps follow Antigravity's documentation; not yet verified by us in Antigravity.

## What zn-gate protects in Antigravity, and what it does not

In Antigravity, zn-gate works as an **MCP server**: the agent can ask it to check a prompt, a tool call or a tool result (`analyze_prompt`, `check_tool_call`, `check_tool_result`). The agent decides when to call these tools, so on its own this is not automatic protection.

| | In Antigravity |
| - | - |
| zn-gate's checks available to the agent (MCP) | Yes |
| Your other MCP servers checked for prompt injection and secrets | Yes, if you wrap them (below) |
| Blocks reads of `.env` and credential files | **No** |
| Removes secrets from shell output and file contents | **No** |
| Blocks a secret pasted into the chat | **No** |

Antigravity has hooks (`PreToolUse`, `PostToolUse` and others, in `.agents/hooks.json`) that can deny or change a tool call, but zn-gate does not install hooks for Antigravity yet. So in Antigravity zn-gate does not block reads of your `.env` or credential files and does not remove secrets from shell output or file contents. If you need that today, use zn-gate with Claude Code, Codex CLI, Cursor or OpenCode: see [compat.md](../compat.md).

## Technical reference

### Where the configuration lives

All projects: `~/.gemini/antigravity/mcp_config.json` (or `~/.gemini/config/mcp_config.json` in some versions). One project: `.agents/mcp_config.json`. `npx -y zn-gate init` wraps the servers in the all-projects file for you, or wrap them by hand as below.

### Check the output of your other MCP servers

To check the output of the other MCP servers you use in Antigravity, start each local server through zn-gate: replace its command with `npx` and put `-y zn-gate shield --` in front of its original command and arguments. For example, a server started with `uvx mcp-server-fetch` becomes:

```json
{
  "mcpServers": {
    "fetch": {
      "command": "npx",
      "args": [
        "-y",
        "zn-gate",
        "shield",
        "--",
        "uvx",
        "mcp-server-fetch"
      ]
    }
  }
}
```

Every result of that server is then checked for prompt injection, and secrets zn-gate recognizes are removed, before the agent sees it. `zn-gate init` does this automatically for Claude Desktop, Claude Code, Cursor, Codex, OpenCode and Antigravity.

## Antigravity documentation

- MCP in Antigravity: <https://antigravity.google/docs/mcp>
- Hooks in Antigravity: <https://antigravity.google/docs/hooks>
