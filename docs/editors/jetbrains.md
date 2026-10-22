# JetBrains AI Assistant

Set up zn-gate in JetBrains AI Assistant (IntelliJ IDEA, PyCharm and other JetBrains IDEs) in two minutes: add it as an MCP server, and what zn-gate does not cover there.

## Quick start (no coding needed)

1. **Check that Node.js is installed.** Open a terminal (in most editors: menu **Terminal → New Terminal**; or your computer's Terminal app), type `node --version` and press Enter. If you see a version number (18 or later), go on. If you see "command not found", install the **LTS** version from [nodejs.org](https://nodejs.org/) and restart your JetBrains IDE.
2. Open **Settings → Tools → AI Assistant → Model Context Protocol (MCP)**, click **Add** (+), and paste the JSON below into the New MCP Server dialog.
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

   Paste it as it is.
4. Click **OK** and apply the settings.

Status: these steps follow JetBrains AI Assistant's documentation; not yet verified by us in JetBrains AI Assistant.

## What zn-gate protects in JetBrains AI Assistant, and what it does not

In JetBrains AI Assistant, zn-gate works as an **MCP server**: the agent can ask it to check a prompt, a tool call or a tool result (`analyze_prompt`, `check_tool_call`, `check_tool_result`). The agent decides when to call these tools, so on its own this is not automatic protection.

| | In JetBrains AI Assistant |
| - | - |
| zn-gate's checks available to the agent (MCP) | Yes |
| Your other MCP servers checked for prompt injection and secrets | Yes, if you wrap them (below) |
| Blocks reads of `.env` and credential files | **No** |
| Removes secrets from shell output and file contents | **No** |
| Blocks a secret pasted into the chat | **No** |

We found no agent hooks in AI Assistant's documentation, so zn-gate can only work as an MCP server there. zn-gate does not block reads of your `.env` or credential files and does not remove secrets from shell output or file contents in JetBrains IDEs. If you need that today, use zn-gate with Claude Code, Codex CLI, Cursor or OpenCode: see [compat.md](../compat.md).

## Technical reference

### Where the configuration lives

Settings → Tools → AI Assistant → Model Context Protocol (MCP), global or per project.

### Check the output of your other MCP servers

To check the output of the other MCP servers you use in JetBrains AI Assistant, start each local server through zn-gate: replace its command with `npx` and put `-y zn-gate shield --` in front of its original command and arguments. For example, a server started with `uvx mcp-server-fetch` becomes:

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

Every result of that server is then checked for prompt injection, and secrets zn-gate recognizes are removed, before the agent sees it. `zn-gate init --wrap-mcp`, which does this automatically for Claude Desktop, Claude Code, Cursor, Codex, OpenCode and Antigravity, does not edit JetBrains AI Assistant's settings.

## Remove zn-gate

JetBrains AI Assistant has no zn-gate hooks, so removing zn-gate here means taking it off your MCP servers. Run these steps in your own terminal, not through your agent. None of them changes your code.

- Delete the `zn-gate` entry you added in the [quick start](#quick-start-no-coding-needed) from JetBrains AI Assistant's MCP settings. Only you can do this: no zn-gate command edits an entry you added by hand.
- If you wrapped other MCP servers with `zn-gate shield --`, put back the command and arguments each one had before, in the same settings.
- Run `npx -y zn-gate init --revert`. It takes zn-gate off the MCP servers that `init --wrap-mcp` wrapped for other agents on this computer. It does not change JetBrains AI Assistant's settings, so the two steps above are still needed here.
- Run `npx -y zn-gate uninstall` to check what zn-gate still has set up on this computer and remove it after you confirm. For the vault, the program itself and the other agents, see [Remove zn-gate](../uninstall.md).

## JetBrains AI Assistant documentation

- MCP in AI Assistant: <https://www.jetbrains.com/help/ai-assistant/mcp.html>
