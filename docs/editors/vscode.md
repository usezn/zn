# VS Code (GitHub Copilot)

Set up zn-gate in VS Code with GitHub Copilot agent mode in two minutes: hooks that block reads of secret files and clean tool output, an MCP server for the agent's own checks, and what is not covered.

## Install (no coding needed)

1. **Check that Node.js is installed.** Open a terminal (in most editors: menu **Terminal → New Terminal**; or your computer's Terminal app), type `node --version` and press Enter. If you see a version number, go on. Node.js 22 LTS is recommended; 18 or later works for the hooks and the CLI, and the Claude Code plugin needs 20.19 or later. If you see "command not found", install the **LTS** version from [nodejs.org](https://nodejs.org/) and restart VS Code.
2. In your own terminal, run:

   ```bash
   npm install -g zn-gate
   zn hooks install copilot
   ```

   It writes one file, `~/.copilot/hooks/zn-gate.json` (for one project only, run `zn hooks install copilot --project` in the project folder: it writes `.github/hooks/zn-gate.json`). Restart VS Code.
3. Check it: run `zn-gate check` in the same terminal. The line "GitHub Copilot (CLI experimental, VS Code not tested)" should say it blocked the `.env` file and allowed the ordinary file.

Optional, for the agent's own checks: add zn-gate as an MCP server. Open the Command Palette (**Ctrl+Shift+P**, or **Cmd+Shift+P** on a Mac), type **MCP: Open User Configuration**, press Enter and paste this in the `mcp.json` that opens:

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

If the file already has a `"servers"` section, add only the `"zn-gate": {...}` part inside it. Save it, then click **Start** in the small links shown above the `zn-gate` entry.

Status: **documented, not tested in the VS Code app.** The hooks follow VS Code's official documentation (below). The same hooks were run end to end with GitHub Copilot CLI 1.0.98 against a scripted model provider (0 secret values sent), not inside the VS Code app.

## What zn-gate protects in VS Code, and what it does not

With the hooks (`zn hooks install copilot`), zn-gate checks every tool call before it runs and the result after it:

| | In VS Code (Copilot harness) |
| - | - |
| Blocks reads and writes of `.env` and credential files by path, and shell commands that handle secrets | Yes (`preToolUse`) |
| Blocks edits of Copilot's own hook and settings files | Yes |
| Removes secret values from the results of read-type and shell tools before the model sees them | Yes (`postToolUse`; successful results only; Copilot's own session log keeps the original) |
| Blocks a secret pasted into the chat | **No**: Copilot drops the output of a command hook for a typed prompt |
| Blocks the call when a hook runs out of time | zn answers itself at 11 seconds, before Copilot's timeout (15 seconds), which on its own would let the call through |
| MCP tools of other servers | Only those Copilot names as read or shell tools; wrap the others with `zn-gate shield` (below) |

### What VS Code's documentation says

All read 2026-10-30; VS Code's hooks are in Preview and may change.

- Page: <https://code.visualstudio.com/docs/agent-customization/hooks>.
- "VS Code, the GitHub Copilot app, and GitHub Copilot CLI share this harness and its hook format" (section on the Copilot harness; select **Copilot** in the **Session Target** control).
- Where it loads hooks from: "User hook files in `~/.copilot/hooks/`, or `$COPILOT_HOME/hooks/` when `COPILOT_HOME` is set" and "`.github/hooks/*.json` at the repository root" (section "Choose a hook source").
- The file: `"version": 1`, a `"hooks"` object, entries with `"type": "command"`, `bash` / `powershell` commands and `timeoutSec` (section "Configure commands and event data"). Events `preToolUse` and `postToolUse` receive `toolName` and `toolArgs`; a `preToolUse` answer of `permissionDecision: "deny"` blocks the call.
- Timeouts "fall through to normal permissions", while a command `preToolUse` error denies the call (section "Decisions and failures"; GitHub's reference says "Timeouts are fail-open for every event": <https://docs.github.com/en/copilot/reference/hooks-reference>). That is why zn blocks by itself before the timeout.
- "Command-hook output is ignored for `userPromptSubmitted`" (section "Events and payloads"): a hook cannot block a typed prompt.
- The Copilot harness also reads the repository's `.claude/settings.json` and `.claude/settings.local.json` with no setting needed, and "Applicable hooks from multiple sources run together" (section "Choose a hook source"); GitHub's reference says "Cross-tool `.claude/settings.json` and `.claude/settings.local.json` files in the repository are also read" (<https://docs.github.com/en/copilot/reference/hooks-reference>). The setting `chat.useClaudeHooks` ("Claude settings files require `chat.useClaudeHooks`") is described in the section on the older **Local** harness, which zn does not document. See the next section.

zn-gate has not run inside the VS Code app: the sections above are what the documentation promises, not something we saw happen in VS Code.

### If zn-gate also protects Claude Code in the same project

If the project holds zn-gate's Claude Code hooks (`zn hooks install claude-code --project` wrote `.claude/settings.json`), the Copilot harness (VS Code and Copilot CLI) can run both files for the same tool call, with no setting needed. Both give the same answer, and the check takes about twice as long (measured by running both installed hooks the way the documented harness starts them; not in VS Code or Copilot CLI: two Node.js starts, 91 ms and 101 ms for one call). `zn-gate check` says so. Keep the Copilot hook: if you do not use Claude Code in this project, run `zn hooks uninstall claude-code --project`; if you do, leave both in place (the only cost is time). Do not remove the Copilot hook: it is the one that checks Copilot's own tool names.

## Questions people ask

**What does zn-gate protect in VS Code?**
With the hooks, it blocks reads and writes of `.env` and credential files and shell commands that handle secrets, and removes secret values from the results of read-type and shell tools. With the MCP server, it gives the agent checks for a prompt, a tool call or a tool result, and it can check your other MCP servers if you wrap them. See [What zn-gate protects in VS Code](#what-zn-gate-protects-in-vs-code-and-what-it-does-not) and [Check the output of your other MCP servers](#check-the-output-of-your-other-mcp-servers).

**What does it not protect?**
It does not block a secret pasted into the chat, and it does not check the MCP tools of other servers unless you wrap them. See [the table above](#what-zn-gate-protects-in-vs-code-and-what-it-does-not).

**How do I undo it?**
Run `zn hooks uninstall copilot` for the hooks. For the MCP server, delete the `zn-gate` entry from the settings file you edited, put back the original command of any server you wrapped, and restart VS Code. See [Uninstall](#uninstall).

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

## Verify

Hooks: run `zn-gate check` in your own terminal (see [Check that it works](../check.md)). It runs zn's rules and the installed hook with a fake `.env`; it does not start VS Code.

MCP server (optional): restart VS Code, then ask the agent to call `zn_status` (or look for the zn-gate tools `analyze_prompt`, `check_tool_call` and `check_tool_result` in the editor's list of MCP tools). If they are listed, the server is running.

## Uninstall

Run each step in your own terminal, not through the agent: zn-gate refuses to uninstall when an AI agent or a script runs it. None of this changes your code. Go in this order, with the MCP servers first, then the hooks, and the program last.

1. **Put back the MCP servers you wrapped.** If you put `-y zn-gate shield --` in front of another server's command (see [Check the output of your other MCP servers](#check-the-output-of-your-other-mcp-servers)), open the settings file you edited, take those words out of its `args` and put back its original command. `zn-gate init --revert` does not do this for you, because `init --wrap-mcp` does not edit VS Code's settings.
2. **Remove the zn-gate MCP server**, if you added it. In the same file (`mcp.json`, opened with **MCP: Open User Configuration**, or `.mcp.json` / `.vscode/mcp.json` in a project), delete the `zn-gate` entry and keep your other servers. Save the file. zn-gate writes no MCP file of its own in VS Code, so no command removes this entry.
3. **Remove the hooks.** Run `zn hooks uninstall copilot`. If you installed them for one project, run `zn hooks uninstall copilot --project` from that project's folder. It removes `zn-gate.json` and leaves other hooks alone. To do it by hand instead, delete the file `~/.copilot/hooks/zn-gate.json` (`$COPILOT_HOME/hooks/zn-gate.json` when you set `COPILOT_HOME`; `.github/hooks/zn-gate.json` in the project): it holds only zn-gate's hooks. GitHub Copilot has no launcher script to delete.
4. **Restart VS Code.**
5. **Check that it is off.** Run `npx -y zn-gate check`. It says which part, if any, is still set up.
6. **Remove the program itself, last.** Run `npm uninstall -g zn-gate` if you installed it globally. If you remove the program first, the hooks stay and point at a command that is gone.

`npx -y zn-gate uninstall` removes the hooks for you (for your user, and for the project folder you run it in) after you confirm the list, but it does not touch the entries you added by hand in VS Code's MCP settings: do steps 1 and 2 yourself. If you ran `env shadow` or keep secrets in the vault, read [Remove zn-gate](../uninstall.md) before you remove the program. For every file zn-gate writes, see [Files zn-gate writes in each editor](remove-by-hand.md#github-copilot-vs-code-cli).

## Troubleshooting

- **`node: command not found`, or Node.js is too old** (zn-gate needs 18 or later): see [Node.js is too old](../troubleshooting.md#1-nodejs-is-too-old) and [`npx: command not found`](../troubleshooting.md#2-npx-command-not-found).
- **"running scripts is disabled on this system" on Windows:** see [the PowerShell message](../troubleshooting.md#3-running-scripts-is-disabled-on-this-system-windows).
- **`zn-gate check` shows a note about checking every call twice:** see "If zn-gate also protects Claude Code in the same project" above.
- **The zn-gate tools do not appear in VS Code:** check that the settings file is valid and that the `zn-gate` entry sits inside the existing server section, then restart VS Code.
- **A command says it needs you at your own terminal:** see [It needs you at your own terminal](../troubleshooting.md#4-it-needs-you-at-your-own-terminal).

All messages: [Troubleshooting](../troubleshooting.md).

## Related pages

- [Install, verify and uninstall by agent](../by-agent.md): the short steps for each agent.
- [Troubleshooting](../troubleshooting.md): all messages and how to fix them.

## VS Code documentation

- MCP servers in VS Code: <https://code.visualstudio.com/docs/agent-customization/mcp-servers>
- Agent hooks (preview): <https://code.visualstudio.com/docs/agent-customization/hooks>
- GitHub's hooks reference (events, exit codes, timeouts): <https://docs.github.com/en/copilot/reference/hooks-reference>
