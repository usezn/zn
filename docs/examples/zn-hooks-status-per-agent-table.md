# Hooks status: the next step for each agent

Use this table after `zn-gate check --hooks` (or `zn-gate check`) lists a hook as STALE or BROKEN. It tells you what to run for each agent. Run every command in your own terminal, not through your AI agent. For the walk-through after an agent update, read [Checklist: check the hooks after an agent update](hooks-status-after-agent-update.md). For what each part of `check` means, read [Check that it works](../check.md#list-every-installed-hook).

The command only reads files. It runs no hook, changes nothing and sends nothing.

## Read one line

Each hook gets one line: its status, the event, the matcher in brackets, and the command the hook runs. This is an illustration with made-up values:

```text
Codex CLI (user): ~/.codex/hooks.json
  STALE  PreToolUse [^(Bash|apply_patch|mcp__.+)$]  '~/.zn/hooks/zn-hook-codex.sh' PreToolUse
  STALE: its launcher script was written by an older zn-gate.
    Fix: run `zn hooks install codex` in your own terminal.

0 OK, 1 stale, 0 broken.
To remove the hooks of an agent instead, run `zn hooks uninstall <agent>`.
```

Each problem is explained once, with its own `Fix:` line. The last line counts the hooks. The exit code is `0` when every hook is OK (or none is set up) and `1` when any hook is STALE or BROKEN.

If no hook is set up at all, the command says:

```text
None found. To set zn up, run `npx -y zn-gate init` in your own terminal.
```

That is not an error. The exit code is `0`.

## What to do for each status

| Status | Meaning | Next step |
|---|---|---|
| `OK` | The hook points at files that exist, and its launcher is the one this zn-gate writes. | Nothing. |
| `STALE` | The hook still works, but an older zn-gate wrote it, or it runs an older copy of a file. | Run the `Fix:` line: `zn hooks install <agent>`. |
| `BROKEN` | The hook cannot run. Its settings file or its launcher is missing or cannot be read, or the hook is written more than once for one event. | Run the `Fix:` line. If you no longer want zn for that agent, run `zn hooks uninstall <agent>` instead. |

The reasons you may see after `BROKEN`, copied as zn prints them (the `<...>` parts are filled in for you):

- `the file is not valid JSON, so <Agent name> cannot read its hooks and zn cannot add its own`: the settings file has a syntax error. Repair it in a text editor first, then run the `Fix:` line.
- `the file cannot be read (too large or no access)`: check the file's permissions, or the file size, then run the `Fix:` line.
- `its Node.js (<path>) is no longer there` and `its zn-gate files (<path>) are no longer there`: you removed or moved what the hook starts. Run the `Fix:` line after you put Node.js or zn-gate back, or uninstall the hook.
- `zn's hook is written <N> times for this event, so every call is checked more than once`: run the `Fix:` line.

## The fix for each agent

Every agent uses the same pattern. Add `--project` when the line says `(project)`, so the fix writes the project file and not the user file.

| Agent | ID to use | Fix for user scope | Fix for project scope | One more thing to check |
|---|---|---|---|---|
| Claude Code | `claude-code` | `zn hooks install claude-code` | `zn hooks install claude-code --project` | If `check` says the plugin and the command are different versions, see [Claude Code plugin](../check.md#claude-code-plugin). |
| Codex CLI | `codex` | `zn hooks install codex` | `zn hooks install codex --project` | Codex runs a new or changed hook only after you trust it. Open Codex, type `/hooks` and approve zn's hooks there. |
| Cursor | `cursor` | `zn hooks install cursor` | `zn hooks install cursor --project` | See [Cursor plugin](../check.md#cursor-plugin) if you use the plugin too. |
| OpenCode | `opencode` | `zn hooks install opencode` | `zn hooks install opencode --project` | A BROKEN line names the Node.js or zn-gate file that is gone. Only the user file is checked for those files. |
| Antigravity | `antigravity` | `zn hooks install antigravity` | `zn hooks install antigravity --project` | A project hook runs `zn` from your PATH. Every teammate who opens the project needs zn-gate installed. |
| GitHub Copilot (VS Code, CLI) | `copilot` | `zn hooks install copilot` | `zn hooks install copilot --project` | If Copilot settings turn hooks off, see [Copilot CLI settings switch the hooks off](../check.md#copilot-cli-settings-switch-the-hooks-off). |
| Gemini CLI (experimental) | `gemini` | `zn hooks install gemini` | `zn hooks install gemini --project` | If Gemini settings turn the hook off, see [Gemini CLI settings switch the hook off](../check.md#gemini-cli-settings-switch-the-hook-off). |
| ZCode | `zcode` | `zn hooks install zcode` | `zn hooks install zcode --project` | If ZCode settings turn the hook off, see [ZCode settings switch the hook off](../check.md#zcode-settings-switch-the-hook-off). |

To remove the hooks of one agent instead, use the same ID: `zn hooks uninstall <agent>`.

## Managed computers

If your organization sets up zn through its managed configuration, `check` counts the agent as set up and names the managed file. If that hook is broken, the line ends with `ask your administrator to repair the managed configuration (<file>)`. That file is not yours to edit, so ask your administrator. See [Your agent ignores zn's hooks on a managed computer](../troubleshooting.md#9-your-agent-ignores-zns-hooks-on-a-managed-computer).

## After the fix

Run the check again, and read the last line:

```sh
zn-gate check --hooks
```

The exit code should now be `0`. Then run `zn-gate check` once to confirm that the agent is protected. See [Checklist: check the hooks after an agent update](hooks-status-after-agent-update.md#4-run-the-check-again).

## Related

- [Check that it works](../check.md): what `check` does, and what each NOT protected line means.
- [Install, verify and uninstall by agent](../by-agent.md): the install, verify and uninstall commands for each agent.
- [Example: remove zn's hooks and check that none is left](hooks-uninstall-then-verify.md).
