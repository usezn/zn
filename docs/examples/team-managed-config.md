# Examples: team managed-config

A worked example of `zn team managed-config`, the command an administrator uses to get the files that make zn-gate's hooks run on every developer machine. The sample output below was produced by running the command; the very long hook command lines are shortened to `...`.

The command only prints. It writes no file and reads no settings of the machine it runs on: the output depends only on the options you pass, except that without `--os` it uses the operating system of that machine. You copy each printed file to the path shown with your own device management or configuration tool (Jamf, Intune, Group Policy, Ansible and the like). The full explanation, with the warnings for each agent, is in [Deploy zn-gate's hooks to every machine](../team.md#deploy-zn-gates-hooks-to-every-machine-managed-settings) and the options are in the [command line reference](../cli.md#team-managed-config).

## Who runs it

An organization admin runs it, on any machine that has zn-gate installed. It needs no account, no vault and no network. Developers do not run it. Each developer machine needs zn-gate installed with `zn` on the PATH (`npm install -g zn-gate`), because the managed hooks run `zn`.

## What it writes and for which agents

Nothing is written. It prints one file per agent and operating system:

| Agent | File | macOS | Linux | Windows |
| --- | --- | --- | --- | --- |
| Claude Code | `managed-settings.json` | `/Library/Application Support/ClaudeCode/` | `/etc/claude-code/` | `C:\Program Files\ClaudeCode\` |
| Cursor | `hooks.json` | `/Library/Application Support/Cursor/` | `/etc/cursor/` | `C:\ProgramData\Cursor\` |
| Codex | `requirements.toml` | `/etc/codex/` | `/etc/codex/` | `%ProgramData%\OpenAI\Codex\` |

By default it prints the files for all three agents, for the operating system of the machine where you run it. Choose with `--agent claude-code|cursor|codex|all` and `--os macos|linux|windows|all`.

## Print the Claude Code file for macOS

```bash
zn team managed-config --agent claude-code --os macos
```

```text
Nothing is written: copy each file to the path shown, with your MDM or configuration tool.

=== Claude Code on macOS ===
File: /Library/Application Support/ClaudeCode/managed-settings.json
Format read from https://code.claude.com/docs/en/managed-settings on 2026-10-19

{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "^(Bash|PowerShell|Monitor|Read|Grep|LSP|Edit|MultiEdit|Write|NotebookEdit|WebFetch)$|^mcp__.*",
        "hooks": [
          {
            "type": "command",
            "command": "sh -c '...'",
            "timeout": 15,
            "onFailure": "block"
          }
        ]
      }
    ],
    ... more events (PostToolUse, UserPromptSubmit and others), each with the same kind of entry ...
  }
}

- If this file already exists, merge the "hooks" entries into it, or save this as managed-settings.d/50-zn.json in the same folder: Claude Code merges the files in that folder with managed-settings.json.
- zn-gate must be installed on each machine with `zn` on the PATH (npm install -g zn-gate).
- allowManagedHooksOnly is off, so developers keep their own hooks. Add --managed-hooks-only to run only managed hooks.
- An MDM profile (macOS) or the Windows registry can carry the same settings; Claude Code selects one managed source, and `claude doctor` shows which.
- To allow zn's MCP server under an existing allowedMcpServers list, add { "serverCommand": ["zn", "secrets-mcp", "--agent", "claude-code"] }. managedMcpServers cannot carry it: it accepts only https http/sse entries with no command.
```

The hooks are the same ones `zn hooks install --scope project` writes. If `zn` or Node.js is missing on a machine, the hook blocks the action and tells the developer how to install zn-gate.

## The two opt-in flags

Both are off by default, because they change what developers can do on their own machines.

| Flag | What it adds | Which agents |
| --- | --- | --- |
| `--managed-hooks-only` | Sets `allowManagedHooksOnly` (Claude Code) or `allow_managed_hooks_only = true` (Codex), so the agent runs only managed hooks. Developers' own hooks, and those of their plugins, stop running. | Claude Code and Codex. No effect on Cursor. |
| `--exclusive-mcp` | Also prints a `managed-mcp.json` with zn's `secrets` server. Claude Code then loads only the servers in that file, so add every server your organization approves before you deploy it. | Claude Code only. No effect on Cursor or Codex. |

## Use the output in a script

```bash
zn team managed-config --agent all --os all --json
```

The JSON has `schema` (currently `1`) and `files`. Each entry in `files` has `agent`, `os`, `file` (the target path), `format` (`json` or `toml`), `content` (the file text), `notes`, `docs` (the vendor page the format comes from) and `read` (the date it was checked).

## If something is wrong

An unknown agent, an unknown operating system or an unknown option prints the reason and the usage line, and exits with code `2`:

```text
zn team managed-config: unknown agent "bogus" (choose claude-code, cursor, codex or all)
usage: zn team managed-config [--agent claude-code|cursor|codex|all] [--os macos|linux|windows|all] [--managed-hooks-only] [--exclusive-mcp] [--json]
```

Run the command again after you update zn-gate, and check the vendor pages if an agent rejects a file.

## See also

- [zn Team on a developer machine](../team.md): what runs on each machine and what the organization can change there.
- [Team quick guide](../team-quick-guide.md): the short version.
- [Command line reference](../cli.md#team-managed-config): all options.
