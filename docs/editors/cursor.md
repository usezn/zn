# Cursor

Set up zn-gate in Cursor in two minutes, then the technical details: the MCP server, the hooks that block secret reads and scrub MCP output, and what Cursor does not let zn-gate cover.

## Quick start (no coding needed)

1. **Check that Node.js is installed.** In Cursor, open **Terminal → New Terminal**, paste `node --version` and press Enter. If you see a version number (18 or later), go on. If you see "command not found", install the **LTS** version from [nodejs.org](https://nodejs.org/), then close and reopen Cursor.
2. **Install zn-gate and turn on its protection for Cursor.** Paste each line in the same terminal and press Enter after each one:

   ```bash
   npm install -g zn-gate
   zn hooks install cursor
   ```

   On a Mac, if you see `EACCES`, follow npm's guide to [fixing permission errors](https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally). On Windows, if PowerShell says running scripts is disabled, type `zn.cmd hooks install cursor` instead (not yet verified).
3. **Restart Cursor.**

Status: these steps follow Cursor's documentation; we have not run them end to end in Cursor yet (Cursor has no command-line mode with hooks that we can test automatically), and not at all on Windows.

Once it works, Cursor's agent is blocked from reading `.env` files with real values and common credential files (file reads and most shell commands), a secret zn-gate recognizes in your chat message is blocked before it is sent, and secrets it recognizes are removed from MCP tool results.

4. **If the agent says it cannot read your `.env` file** (optional): run `zn unlock` (it creates your local vault the first time), then `zn env shadow .env`. Your `.env` then holds markers instead of real values, and zn-gate fills the values in only for commands you allow.

To undo it: `zn hooks uninstall cursor`.

## What zn-gate protects in Cursor, and what it does not

| | In Cursor |
| - | - |
| Blocks reads of `.env` files with values, credential files (`~/.aws/credentials`, `~/.ssh/id_*`…) and `~/.zn` | Yes, for file reads and shell commands |
| Removes secrets from MCP tool results | Yes |
| Blocks secrets sent in MCP tool arguments | Yes, in the next release after 1.6.0 |
| Blocks a secret pasted into the chat | Yes |
| Removes secrets from shell output and file contents | **No.** Cursor does not let hooks change them |
| Checks your other MCP servers for prompt injection | Yes, if you wrap them (below) |
| Cursor CLI (`cursor-agent`) | Not covered: its hook support is not documented |

**Not covered:** a secret printed by a shell command, or written in a file the agent reads that is not blocked, reaches the model. Keep secrets in zn-gate's vault (`zn unlock`, then `zn env shadow .env`) so your files hold markers instead of real values: see [Scrubber](https://usezn.com/docs/zn-gate/scrubber/). Hooks are a guardrail, not a sandbox.

## Technical reference

### zn-gate as an MCP server

One click (not yet verified): open this link in your browser and Cursor asks you to confirm.

```text
cursor://anysphere.cursor-deeplink/mcp/install?name=zn-gate&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsInpuLWdhdGUiLCJtY3AiXX0%3D
```

Or add it by hand to `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project):

```json
{ "mcpServers": { "zn-gate": { "command": "npx", "args": ["-y", "zn-gate", "mcp"] } } }
```

The agent can then call `analyze_prompt`, `check_tool_call`, `check_tool_result` and `zn_status`. The agent decides when to call them, so on its own this is not automatic protection; the hooks above are.

### Check the output of your other MCP servers

```bash
npx -y zn-gate init --dry-run   # shows what would change
npx -y zn-gate init             # wraps each local server with zn-gate shield (a backup is written first)
```

Every result of a wrapped server is checked for prompt injection, and secrets zn-gate recognizes are removed, before the agent sees it. `npx -y zn-gate init --revert` restores the backup.

### The hooks

`zn hooks install cursor` writes Cursor's `hooks.json` (zn-gate 1.5 and later, npm):

- `beforeMCPExecution` denies an MCP call whose arguments carry a secret value or a `__ZN_` marker, unless it goes to zn's `secrets` server (next release after 1.6.0; run `zn hooks install cursor` again to add it).
- `beforeReadFile` and `beforeSubmitPrompt` fail closed: if the hook crashes or times out, the read or the prompt is blocked.
- `beforeShellExecution` blocks commands that read secret files and points the agent to `zn run` for commands that need a secret.
- `postToolUse` removes secrets from MCP tool output (the only output Cursor lets a hook change).
- `preToolUse` checks writes and deletes on a best-effort basis: Cursor does not document the input of every tool.

Per-agent details and how each agent compares: [compat.md](../compat.md).

## Cursor documentation

- MCP: <https://cursor.com/docs/context/mcp>
- MCP install links: <https://cursor.com/docs/context/mcp/install-links>
- Hooks: <https://cursor.com/docs/hooks>
