# VS Code (GitHub Copilot)

Set up zn-gate in VS Code with GitHub Copilot agent mode in two minutes: add it as an MCP server, and what zn-gate does not cover there yet.

## Quick start (no coding needed)

1. **Check that Node.js is installed.** Open a terminal (in most editors: menu **Terminal → New Terminal**; or your computer's Terminal app), type `node --version` and press Enter. If you see a version number (18 or later), go on. If you see "command not found", install the **LTS** version from [nodejs.org](https://nodejs.org/) and restart VS Code.
2. Open the Command Palette (**Ctrl+Shift+P**, or **Cmd+Shift+P** on a Mac), type **MCP: Open User Configuration** and press Enter. VS Code opens a file called `mcp.json`.
3. Paste this:

   ```json
   {
     "servers": {
       "zn-gate": {
         "type": "stdio",
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

   If the file already has a `"servers"` section, add only the `"zn-gate": {...}` part inside it.
4. Save the file, then click **Start** in the small links shown above the `zn-gate` entry (or run **MCP: List Servers** from the Command Palette).

Status: these steps follow VS Code's documentation; not yet verified by us in VS Code.

## What zn-gate protects in VS Code, and what it does not

In VS Code, zn-gate works as an **MCP server**: the agent can ask it to check a prompt, a tool call or a tool result (`analyze_prompt`, `check_tool_call`, `check_tool_result`). The agent decides when to call these tools, so on its own this is not automatic protection.

| | In VS Code |
| - | - |
| zn-gate's checks available to the agent (MCP) | Yes |
| Your other MCP servers checked for prompt injection and secrets | Yes, if you wrap them (below) |
| Blocks reads of `.env` and credential files | **No** |
| Removes secrets from shell output and file contents | **No** |
| Blocks a secret pasted into the chat | **No** |

VS Code has agent hooks in preview (`PreToolUse`, `PostToolUse` and others, in `.github/hooks/*.json`), but zn-gate does not install hooks for VS Code yet, and we have not checked whether VS Code hooks see MCP tool calls. So in VS Code zn-gate does not block reads of your `.env` or credential files and does not remove secrets from shell output or file contents. If you need that today, use zn-gate with Claude Code, Codex CLI, Cursor or OpenCode: see [compat.md](../compat.md).

## Technical reference

### Where the configuration lives

User: **MCP: Open User Configuration**. One project: `.mcp.json` at the project root (top-level key `mcpServers`), which VS Code now recommends; `.vscode/mcp.json` (top-level key `servers`) still works.

### Check the output of your other MCP servers

To check the output of the other MCP servers you use in VS Code, start each local server through zn-gate: replace its command with `npx` and put `-y zn-gate shield --` in front of its original command and arguments. For example, a server started with `uvx mcp-server-fetch` becomes:

```json
{
  "servers": {
    "fetch": {
      "type": "stdio",
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

Every result of that server is then checked for prompt injection, and secrets zn-gate recognizes are removed, before the agent sees it. `zn-gate init --wrap-mcp`, which does this automatically for Claude Desktop, Claude Code, Cursor, Codex, OpenCode and Antigravity, does not edit VS Code's settings.

## Remove zn-gate

VS Code has no zn-gate hooks, so removing zn-gate here means taking it off your MCP servers. Run these steps in your own terminal, not through your agent. None of them changes your code.

- Delete the `zn-gate` entry you added in the [quick start](#quick-start-no-coding-needed) from VS Code's MCP settings. Only you can do this: no zn-gate command edits an entry you added by hand.
- If you wrapped other MCP servers with `zn-gate shield --`, put back the command and arguments each one had before, in the same settings.
- Run `npx -y zn-gate init --revert`. It takes zn-gate off the MCP servers that `init --wrap-mcp` wrapped for other agents on this computer. It does not change VS Code's settings, so the two steps above are still needed here.
- Run `npx -y zn-gate uninstall` to check what zn-gate still has set up on this computer and remove it after you confirm. For the vault, the program itself and the other agents, see [Remove zn-gate](../uninstall.md).

## VS Code documentation

- MCP servers in VS Code: <https://code.visualstudio.com/docs/copilot/customization/mcp-servers>
- Agent hooks (preview): <https://code.visualstudio.com/docs/agent-customization/hooks>
