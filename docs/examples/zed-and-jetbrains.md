# Example: connect, check and remove zn-gate in Zed and JetBrains

A short walk-through for Zed and for a JetBrains editor (IntelliJ IDEA, PyCharm and others with AI Assistant). In both, zn-gate works only as an MCP server: it does not block reads of `.env` files and does not remove secrets from shell output or file contents there. Full steps: [Zed](../editors/zed.md) and [JetBrains AI Assistant](../editors/jetbrains.md). Command details: [command reference](../cli.md).

The examples use a made-up project folder, `/home/user/example-project`.

## Zed

### Connect in Zed

1. In a terminal, run `node --version`. Node.js 22 LTS is recommended; 18 or later works for the hooks and the CLI, and the Claude Code plugin needs 20.19 or later.
2. In Zed, open the Command Palette and run **zed: open settings file**.
3. Add this to the file (if `"context_servers"` already exists, add only the `"zn-gate"` part inside it), then save:

   ```json
   {
     "context_servers": {
       "zn-gate": {
         "command": "npx",
         "args": ["-y", "zn-gate", "mcp"],
         "env": {}
       }
     }
   }
   ```

### Check in Zed

Restart Zed and ask the agent to call `zn_status`, or look for `analyze_prompt`, `check_tool_call` and `check_tool_result` in the list of MCP tools. If they are listed, the server is running.

Do not use `zn-gate check` for this. It checks hooks, and zn-gate does not install hooks for Zed.

### Remove from Zed

Open the same settings file, delete the `zn-gate` entry, save, and restart Zed. If you wrapped another server with `zn-gate shield`, put back its original command. To remove the program itself, run `npm uninstall -g zn-gate` if you installed it globally.

## JetBrains editor

### Connect in JetBrains

1. In the editor's terminal, in `/home/user/example-project`, run `node --version`. Node.js 22 LTS is recommended; 18 or later works for the hooks and the CLI, and the Claude Code plugin needs 20.19 or later.
2. Open **Settings → Tools → AI Assistant → Model Context Protocol (MCP)** and click **Add** (+).
3. Paste this into the New MCP Server dialog, click **OK** and apply the settings:

   ```json
   {
     "mcpServers": {
       "zn-gate": {
         "command": "npx",
         "args": ["-y", "zn-gate", "mcp"]
       }
     }
   }
   ```

### Check in JetBrains

Restart the IDE and ask the agent to call `zn_status`, or look for the three zn-gate tools in the list of MCP tools. As in Zed, `zn-gate check` does not test this setup, because zn-gate does not install hooks for JetBrains AI Assistant.

### Remove from JetBrains

Open the MCP settings you edited, delete the `zn-gate` entry, save, and restart the IDE. Put back the original command of any server you wrapped with `zn-gate shield`. To remove the program itself, run `npm uninstall -g zn-gate` if you installed it globally.

## Optional: check another MCP server

In both editors, start a local server through `zn-gate shield --`. A server started with `uvx mcp-server-fetch` runs as `npx -y zn-gate shield -- uvx mcp-server-fetch`: put `npx` in `command` and the rest in `args`. `zn-gate init --wrap-mcp` does not edit Zed or JetBrains settings.

## More

- [Zed](../editors/zed.md) and [JetBrains AI Assistant](../editors/jetbrains.md): the full pages, with troubleshooting.
- [Check that it works](../check.md) and [Remove zn-gate](../uninstall.md).
