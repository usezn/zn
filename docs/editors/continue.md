# Continue

Set up zn-gate in Continue in two minutes: add it as an MCP server, and what zn-gate does not cover there.

## Quick start (no coding needed)

1. **Check that Node.js is installed.** Open a terminal (in most editors: menu **Terminal → New Terminal**; or your computer's Terminal app), type `node --version` and press Enter. If you see a version number (18 or later), go on. If you see "command not found", install the **LTS** version from [nodejs.org](https://nodejs.org/) and restart VS Code (or your editor).
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

Every result of that server is then checked for prompt injection, and secrets zn-gate recognizes are removed, before the agent sees it. `zn-gate init`, which does this automatically for Claude Desktop, Claude Code, Cursor, Codex, OpenCode and Antigravity, does not edit Continue's settings.

## Continue documentation

- MCP in Continue: <https://docs.continue.dev/customize/deep-dives/mcp>
