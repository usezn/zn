# Windsurf (Devin Desktop)

Set up zn-gate in Windsurf (Devin Desktop, Cascade) in two minutes: add it as an MCP server, and what zn-gate does not cover there yet.

## Quick start (no coding needed)

1. **Check that Node.js is installed.** Open a terminal (in most editors: menu **Terminal → New Terminal**; or your computer's Terminal app), type `node --version` and press Enter. If you see a version number (18 or later), go on. If you see "command not found", install the **LTS** version from [nodejs.org](https://nodejs.org/) and restart Windsurf.
2. Open the MCP configuration file: on macOS and Linux `~/.config/devin/mcp_config.json`, on Windows `%APPDATA%\devin\mcp_config.json`. If it does not exist, create it. (`~` is your user folder. Older Windsurf versions used `~/.codeium/windsurf/mcp_config.json`, not verified.)
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
4. Save the file and refresh the MCP servers in the Cascade panel (or restart the app).

Status: these steps follow Windsurf's documentation; not yet verified by us in Windsurf.

## What zn-gate protects in Windsurf, and what it does not

In Windsurf, zn-gate works as an **MCP server**: the agent can ask it to check a prompt, a tool call or a tool result (`analyze_prompt`, `check_tool_call`, `check_tool_result`). The agent decides when to call these tools, so on its own this is not automatic protection.

| | In Windsurf |
| - | - |
| zn-gate's checks available to the agent (MCP) | Yes |
| Your other MCP servers checked for prompt injection and secrets | Yes, if you wrap them (below) |
| Blocks reads of `.env` and credential files | **No** |
| Removes secrets from shell output and file contents | **No** |
| Blocks a secret pasted into the chat | **No** |

Cascade has hooks: `pre_mcp_tool_use`, `pre_run_command` and `pre_read_code` can block an action (exit code 2), but its documentation does not describe a way for hooks to change a tool's output, and zn-gate does not install hooks for Cascade yet. So in Windsurf zn-gate does not block reads of your `.env` or credential files and does not remove secrets from shell output or file contents. If you need that today, use zn-gate with Claude Code, Codex CLI, Cursor or OpenCode: see [compat.md](../compat.md).

## Technical reference

### Where the configuration lives

macOS and Linux: `~/.config/devin/mcp_config.json`. Windows: `%APPDATA%\devin\mcp_config.json`.

### Check the output of your other MCP servers

To check the output of the other MCP servers you use in Windsurf, start each local server through zn-gate: replace its command with `npx` and put `-y zn-gate shield --` in front of its original command and arguments. For example, a server started with `uvx mcp-server-fetch` becomes:

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

Every result of that server is then checked for prompt injection, and secrets zn-gate recognizes are removed, before the agent sees it. `zn-gate init`, which does this automatically for Claude Desktop, Claude Code, Cursor, Codex, OpenCode and Antigravity, does not edit Windsurf's settings.

## Windsurf documentation

- MCP in Cascade: <https://docs.devin.ai/desktop/cascade/mcp>
- Cascade hooks: <https://docs.devin.ai/desktop/cascade/hooks>
