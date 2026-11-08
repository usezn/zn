# Continue

Set up zn-gate in Continue in two minutes: add it as an MCP server, and what zn-gate does not cover there.

## Install (no coding needed)

1. **Check that Node.js is installed.** Open a terminal (in most editors: menu **Terminal → New Terminal**; or your computer's Terminal app), type `node --version` and press Enter. If you see a version number, go on. Node.js 22 LTS is recommended; 18 or later works for the hooks and the CLI, and the Claude Code plugin needs 20.19 or later. If you see "command not found", install the **LTS** version from [nodejs.org](https://nodejs.org/) and restart VS Code (or your editor).
2. Open your Continue configuration file (`config.yaml`; in the Continue panel, open the settings and choose to edit the configuration).
3. Paste this:

   ```yaml
   mcpServers:
     - name: zn-gate
       type: stdio
       command: npx
       args: ["-y", "zn-gate", "mcp"]
   ```

   If the file already has an `mcpServers:` list, add only the `- name: zn-gate` entry to it.

   If you prefer one file per project, create `.continue/mcpServers/zn-gate.yaml` in your project instead, with:

   ```yaml
   name: zn-gate
   version: 1.0.0
   schema: v1
   mcpServers:
     - name: zn-gate
       type: stdio
       command: npx
       args: ["-y", "zn-gate", "mcp"]
   ```

   Standalone files in `.continue/mcpServers/` need the `name`, `version` and `schema` lines at the top; your main `config.yaml` does not.
4. Save the file. zn-gate's tools are available in Continue's **Agent** mode only.

Status: these steps follow Continue's documentation; not yet verified by us in Continue.

## What zn-gate protects in Continue, and what it does not

In Continue, zn-gate works as an **MCP server**: the agent can ask it to check a prompt, a tool call or a tool result (`analyze_prompt`, `check_tool_call`, `check_tool_result`). The agent decides when to call these tools, so on its own this is not automatic protection.

| | In Continue |
| - | - |
| zn-gate's checks available to the agent (MCP) | Yes |
| Your other MCP servers checked for prompt injection and secrets | Yes, if you wrap them (below) |
| Blocks reads of `.env` and credential files | **No** |
| Removes secrets from shell output and file contents | **No** |
| Blocks a secret pasted into the chat | **No** |

We found no agent hooks in Continue's documentation, so zn-gate can only work as an MCP server there. zn-gate does not block reads of your `.env` or credential files and does not remove secrets from shell output or file contents in Continue. If you need that today, use zn-gate with Claude Code, Codex CLI, Cursor or OpenCode: see [compat.md](../compat.md).

## Technical reference

### Where the configuration lives

Your Continue `config.yaml` (`mcpServers` is a list), or a file in `.continue/mcpServers/` in your project (a standalone file there also needs `name`, `version` and `schema` at the top).

### Check the output of your other MCP servers

To check the output of the other MCP servers you use in Continue, start each local server through zn-gate: replace its command with `npx` and put `-y zn-gate shield --` in front of its original command and arguments. For example, a server started with `uvx mcp-server-fetch` becomes:

```yaml
mcpServers:
  - name: fetch
    type: stdio
    command: npx
    args: ["-y", "zn-gate", "shield", "--", "uvx", "mcp-server-fetch"]
```

Every result of that server is then checked for prompt injection, and secrets zn-gate recognizes are removed, before the agent sees it. `zn-gate init --wrap-mcp`, which does this automatically for Claude Desktop, Claude Code, Cursor, Codex, OpenCode and Antigravity, does not edit Continue's settings.

## Verify

Restart Continue, then ask the agent to call `zn_status` (or look for the zn-gate tools `analyze_prompt`, `check_tool_call` and `check_tool_result` in the editor's list of MCP tools). If they are listed, the server is running.

When the agent calls `zn_status`, it answers with its status as text. With the cloud check off (the default), the answer is:

```json
{
  "package": "zn-gate@X.Y.Z",
  "engine": "local-rules",
  "endpoint": "none (local only)",
  "rules_version": "<rules_version>",
  "cloud_enabled": false,
  "leaves_machine": "nothing",
  "lifecycle_coverage": "bidirectional (prompt, pre-tool-call, post-tool-result)"
}
```

The block above shows placeholders: your answer shows the package version and the rules version of the zn-gate you have installed. With the optional cloud check on ([Turn on the optional cloud check](../connect.md)), the fields change: `engine` becomes `local-rules + cloud (analyze_prompt only)`, `endpoint` names the address of the cloud check, `cloud_enabled` becomes `true`, and `leaves_machine` says: "analyze_prompt text only, with secrets redacted locally before sending. Tool results and tool-call arguments never leave the machine."

`npx -y zn-gate check` does not test this setup: it checks hooks, and zn-gate does not install hooks for Continue yet. See [Check that it works](../check.md).

## Uninstall

Open the settings file you edited in Install, delete the `zn-gate` entry (and any wrapper you added around another MCP server with `zn-gate shield`, putting back its original command), save the file and restart Continue. No other part of zn-gate is installed by these steps, and none of this changes your code. To remove the program itself, run `npm uninstall -g zn-gate` if you installed it globally. See [Remove zn-gate](../uninstall.md).

## Troubleshooting

| Symptom | Cause | Fix |
| - | - | - |
| `node: command not found`, or Node.js is too old | Node.js is missing or older than 18 (zn-gate needs 18 or later) | See [Node.js is too old](../troubleshooting.md#1-nodejs-is-too-old) and [`npx: command not found`](../troubleshooting.md#2-npx-command-not-found) |
| "running scripts is disabled on this system" on Windows | PowerShell blocks running scripts | See [the PowerShell message](../troubleshooting.md#3-running-scripts-is-disabled-on-this-system-windows) |
| The zn-gate tools do not appear in Continue | The settings file is not valid, or the `zn-gate` entry is not inside the existing server section | Check that the settings file is valid and that the `zn-gate` entry sits inside the existing server section, then restart Continue |
| A command says it needs you at your own terminal | The command must be run at your own terminal | See [It needs you at your own terminal](../troubleshooting.md#4-it-needs-you-at-your-own-terminal) |

All messages: [Troubleshooting](../troubleshooting.md).

## Continue documentation

- MCP in Continue: <https://docs.continue.dev/customize/deep-dives/mcp>
