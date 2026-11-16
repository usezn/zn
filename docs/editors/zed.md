# Zed

Set up zn-gate in Zed in two minutes: add it as an MCP server, and what zn-gate does not cover there.

## Install (no coding needed)

1. **Check that Node.js is installed.** Open a terminal (in most editors: menu **Terminal → New Terminal**; or your computer's Terminal app), type `node --version` and press Enter. If you see a version number, go on. Node.js 22 LTS is recommended; 18 or later works for the hooks and the CLI, and the Claude Code plugin needs 20.19 or later. If you see "command not found", install the **LTS** version from [nodejs.org](https://nodejs.org/) and restart Zed.
2. Open the Command Palette (**Ctrl+Shift+P**, or **Cmd+Shift+P** on a Mac), type **zed: open settings file** and press Enter.
3. Paste this:

   ```json
   {
     "context_servers": {
       "zn-gate": {
         "command": "npx",
         "args": [
           "-y",
           "zn-gate",
           "mcp"
         ],
         "env": {}
       }
     }
   }
   ```

   If the file already has a `"context_servers"` section, add only the `"zn-gate": {...}` part inside it. Or use **Settings → AI → MCP Servers → Add Server → Add Local Server**.
4. Save the file.
5. **Is it working?** Restart Zed, then in a terminal run:

   ```bash
   npx -y zn-gate status
   npx -y zn-gate check
   ```

   `status` shows the version and whether the optional cloud check is on. `check` prints one line for each agent it finds, then a closing sentence. A good result looks like this:

   ```text
   zn-gate check: does zn stop your coding agent from reading a secret?

     OK Claude Code  blocked the .env file and allowed the ordinary file. ...
     -  Codex CLI    zn is not set up for this agent. ...
     -  Cursor       not found on this machine

   Your agent cannot read secret files such as .env through these tools. Nothing was sent anywhere.
   ```

   **OK** means zn protects that agent; **-** means zn is not set up for it or it is not on this machine; a line that says **NOT protected** needs the fix it names (see [Check that it works](../check.md)). Zed is not listed, because zn-gate does not install hooks for Zed yet: `check` does not test this setup. To confirm the server itself, see [Verify](#verify).

Status: these steps follow Zed's documentation; not yet verified by us in Zed.

## What zn-gate protects in Zed, and what it does not

In Zed, zn-gate works as an **MCP server**: the agent can ask it to check a prompt, a tool call or a tool result (`analyze_prompt`, `check_tool_call`, `check_tool_result`). The agent decides when to call these tools, so on its own this is not automatic protection.

| | In Zed |
| - | - |
| zn-gate's checks available to the agent (MCP) | Yes |
| Your other MCP servers checked for prompt injection and secrets | Yes, if you wrap them (below) |
| Blocks reads of `.env` and credential files | **No** |
| Removes secrets from shell output and file contents | **No** |
| Blocks a secret pasted into the chat | **No** |

We found no agent hooks in Zed's documentation, so zn-gate can only work as an MCP server there. In Zed zn-gate does not block reads of your `.env` or credential files and does not remove secrets from shell output or file contents. If you need that today, use zn-gate with Claude Code, Codex CLI, Cursor or OpenCode: see [compat.md](../compat.md).

## Technical reference

### Where the configuration lives

Your Zed `settings.json`, key `context_servers`.

### Check the output of your other MCP servers

To check the output of the other MCP servers you use in Zed, start each local server through zn-gate: replace its command with `npx` and put `-y zn-gate shield --` in front of its original command and arguments. For example, a server started with `uvx mcp-server-fetch` becomes:

```json
{
  "context_servers": {
    "fetch": {
      "command": "npx",
      "args": [
        "-y",
        "zn-gate",
        "shield",
        "--",
        "uvx",
        "mcp-server-fetch"
      ],
      "env": {}
    }
  }
}
```

Every result of that server is then checked for prompt injection, and secrets zn-gate recognizes are removed, before the agent sees it. `zn-gate init --wrap-mcp`, which does this automatically for Claude Desktop, Claude Code, Cursor, Codex, OpenCode and Antigravity, does not edit Zed's settings.

## Verify

Restart Zed, then ask the agent to call `zn_status` (or look for the zn-gate tools `analyze_prompt`, `check_tool_call` and `check_tool_result` in the editor's list of MCP tools). If they are listed, the server is running.

`npx -y zn-gate check` does not test this setup: it checks hooks, and zn-gate does not install hooks for Zed yet. See [Check that it works](../check.md).

## Uninstall

Open the settings file you edited in Install, delete the `zn-gate` entry (and any wrapper you added around another MCP server with `zn-gate shield`, putting back its original command), save the file and restart Zed. No other part of zn-gate is installed by these steps, and none of this changes your code. To remove the program itself, run `npm uninstall -g zn-gate` if you installed it globally. See [Remove zn-gate](../uninstall.md).

## Troubleshooting

- **`node: command not found`, or Node.js is too old** (zn-gate needs 18 or later): see [Node.js is too old](../troubleshooting.md#1-nodejs-is-too-old) and [`npx: command not found`](../troubleshooting.md#2-npx-command-not-found).
- **"running scripts is disabled on this system" on Windows:** see [the PowerShell message](../troubleshooting.md#3-running-scripts-is-disabled-on-this-system-windows).
- **The zn-gate tools do not appear in Zed:** check that the settings file is valid and that the `zn-gate` entry sits inside the existing server section, then restart Zed. If they still do not appear, see [The zn-gate MCP server does not start](#the-zn-gate-mcp-server-does-not-start).
- **A command says it needs you at your own terminal:** see [It needs you at your own terminal](../troubleshooting.md#4-it-needs-you-at-your-own-terminal).

### The zn-gate MCP server does not start

If Zed lists `zn-gate` as an MCP server but it never starts, or the zn-gate tools stay missing after a restart, these are the three most common causes. To see why Zed could not start it, open the Command Palette, type **zed: open log** and press Enter, then search the log for `zn-gate`. Run the commands below in your own terminal, not through your AI agent.

1. **Zed cannot find `npx`, or Node.js is too old.**
   - **Check:** run `node --version` and `npx --version`. `node --version` must show 18 or later. Then run `which npx` (macOS and Linux) or `where.exe npx` (Windows; in PowerShell, plain `where` is a different command) to see where `npx` is.
   - **Fix:** if either command fails, install the **LTS** version from [nodejs.org](https://nodejs.org/), then quit Zed completely and open it again: a Zed window opened before the install does not see the new `npx`. If you installed Node.js with a version manager such as nvm, Zed may not see it: replace `"npx"` in the `"command"` line with the full path that `which npx` or `where.exe npx` printed. See [Node.js is too old](../troubleshooting.md#1-nodejs-is-too-old) and [`npx: command not found`](../troubleshooting.md#2-npx-command-not-found).
2. **The settings file cannot be read, or the entry is in the wrong place.**
   - **Check:** open the settings file again (**zed: open settings file**). The `zn-gate` entry must sit inside one `"context_servers"` section at the top level of the file, and the file must have exactly one `"context_servers"` key. Look for a missing comma or brace next to the lines you pasted.
   - **Fix:** move the `"zn-gate": {...}` part into the existing `"context_servers"` section, delete the second `"context_servers"` key if there is one, save the file and restart Zed.
3. **npm cannot download zn-gate the first time.** The first start runs `npx -y zn-gate mcp`, which downloads zn-gate from the npm registry. Without a connection, or behind a VPN or proxy that blocks npm, the server stops before it starts.
   - **Check:** run `npx -y zn-gate --version`. It must print a line that starts with `zn-gate` and a version number.
   - **Fix:** if it prints an npm error instead, check your connection, VPN or proxy and run it again. Once it prints the version, restart Zed. To stop downloading at each start, run `npm install -g zn-gate`, then use `"command": "zn-gate"` and `"args": ["mcp"]` in the entry. See [Init cannot install zn-gate: no internet connection](../troubleshooting.md#12-init-cannot-install-zn-gate-no-internet-connection).

After the fix, follow [Verify](#verify) to check that the server runs. These checks follow Zed's documentation and were not yet run by us in Zed.

All messages: [Troubleshooting](../troubleshooting.md).

## See also

- [Editors index](README.md)
- [Remove zn-gate by hand](remove-by-hand.md)
- [zn-gate by agent](../by-agent.md)
- [Remove zn-gate](../uninstall.md)

## Zed documentation

- MCP in Zed: <https://zed.dev/docs/ai/mcp>
