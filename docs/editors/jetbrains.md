# JetBrains AI Assistant

Set up zn-gate in JetBrains AI Assistant (IntelliJ IDEA, PyCharm and other JetBrains IDEs) in two minutes: add it as an MCP server, and what zn-gate does not cover there.

## Install (no coding needed)

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

## Verify

Restart JetBrains AI Assistant, then ask the agent to call `zn_status` (or look for the zn-gate tools `analyze_prompt`, `check_tool_call` and `check_tool_result` in the editor's list of MCP tools). If they are listed, the server is running.

`npx -y zn-gate check` does not test this setup: it checks hooks, and zn-gate does not install hooks for JetBrains AI Assistant yet. See [Check that it works](../check.md).

## Uninstall

Open the settings file you edited in Install, delete the `zn-gate` entry (and any wrapper you added around another MCP server with `zn-gate shield`, putting back its original command), save the file and restart JetBrains AI Assistant. No other part of zn-gate is installed by these steps, and none of this changes your code. To remove the program itself, run `npm uninstall -g zn-gate` if you installed it globally. See [Remove zn-gate](../uninstall.md).

## Troubleshooting

- **`node: command not found`, or Node.js is too old** (zn-gate needs 18 or later): see [Node.js is too old](../troubleshooting.md#1-nodejs-is-too-old) and [`npx: command not found`](../troubleshooting.md#2-npx-command-not-found).
- **"running scripts is disabled on this system" on Windows:** see [the PowerShell message](../troubleshooting.md#3-running-scripts-is-disabled-on-this-system-windows).
- **The zn-gate tools do not appear in JetBrains AI Assistant:** check that the settings file is valid and that the `zn-gate` entry sits inside the existing server section, then restart JetBrains AI Assistant.
- **A command says it needs you at your own terminal:** see [It needs you at your own terminal](../troubleshooting.md#4-it-needs-you-at-your-own-terminal).

All messages: [Troubleshooting](../troubleshooting.md).

## JetBrains AI Assistant documentation

- MCP in AI Assistant: <https://www.jetbrains.com/help/ai-assistant/mcp.html>
