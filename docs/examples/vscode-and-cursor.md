# VS Code and Cursor side by side

Install, verify and uninstall zn-gate for both editors on one page. The commands are copied from each editor's page; read those pages for the full steps and details.

The two editors are set up differently. In Cursor, zn-gate installs hooks. In VS Code, you add zn-gate as an MCP server by hand, and zn-gate does not install hooks for VS Code yet.

Both need Node.js 18 or later: run `node --version` in a terminal to check.

## At a glance

| | VS Code (GitHub Copilot) | Cursor |
| - | - | - |
| Install | Add the zn-gate MCP server to `mcp.json` | `npm install -g zn-gate`, then `zn hooks install cursor` |
| Verify | Ask the agent to call `zn_status` | `npx -y zn-gate check` |
| Uninstall | Delete the `zn-gate` entry and restart | `zn hooks uninstall cursor` |

## VS Code

Full page: [VS Code (GitHub Copilot)](../editors/vscode.md).

**Install.** Open the Command Palette (**Ctrl+Shift+P**, or **Cmd+Shift+P** on a Mac), run **MCP: Open User Configuration**, and paste this into `mcp.json`:

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

If the file already has a `"servers"` section, add only the `"zn-gate": {...}` part inside it. Save the file, then click **Start** above the `zn-gate` entry.

**Verify.** Restart VS Code, then ask the agent to call `zn_status`, or look for the tools `analyze_prompt`, `check_tool_call` and `check_tool_result` in the list of MCP tools. `npx -y zn-gate check` does not test this setup, because it checks hooks. See [VS Code: Verify](../editors/vscode.md#verify).

**Uninstall.** Delete the `zn-gate` entry from the file you edited (and put back the original command of any server you wrapped with `zn-gate shield`), save, and restart VS Code. See [VS Code: Uninstall](../editors/vscode.md#uninstall).

## Cursor

Full page: [Cursor](../editors/cursor.md).

**Install.** In a terminal, run:

```bash
npm install -g zn-gate
zn hooks install cursor
```

Then restart Cursor. On Windows, if PowerShell says running scripts is disabled, type `zn.cmd hooks install cursor` instead (not yet verified).

**Verify.** Run this in your own terminal:

```bash
npx -y zn-gate check
```

It reports whether the Cursor hook blocked a fake `.env` file and allowed an ordinary file. Nothing is sent over the network and no setting changes. To check the MCP server too, restart Cursor and ask the agent to call `zn_status`. See [Cursor: Verify](../editors/cursor.md#verify) and [Check that it works](../check.md).

**Uninstall.** In your own terminal:

```bash
zn hooks uninstall cursor
```

Add `--project` and run it from the project's folder if you installed for one project only. To remove the MCP server, delete the `zn-gate` entry from the MCP settings file you edited. See [Cursor: Uninstall](../editors/cursor.md#uninstall).

## What each editor covers

| | VS Code | Cursor |
| - | - | - |
| zn-gate's checks available to the agent (MCP) | Yes | Yes |
| Blocks reads of `.env` and credential files | **No** | Yes, for file reads and shell commands |
| Blocks a secret pasted into the chat | **No** | Yes |
| Removes secrets from shell output and file contents | **No** | **No** |

See [VS Code: what it protects](../editors/vscode.md#what-zn-gate-protects-in-vs-code-and-what-it-does-not) and [Cursor: what it protects](../editors/cursor.md#what-zn-gate-protects-in-cursor-and-what-it-does-not). All agents: [By agent](../by-agent.md). To remove everything: [Remove zn-gate](../uninstall.md).
