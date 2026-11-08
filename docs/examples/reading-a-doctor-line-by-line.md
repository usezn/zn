# Example: reading a doctor line by line

A walk through the output of `zn-gate check --hooks` (`doctor` is another name for `check`). It lists every zn hook set up for your agents and says whether each one is working. The output below was captured on a throwaway machine with fake settings, with the folder names shortened to `~`. For every reason a line can give, see [List every installed hook](../check.md#list-every-installed-hook). For a test that zn really blocks a secret, use `zn-gate check` without `--hooks`, as in [reading a check output line by line](check-output-explained.md).

The command only reads your agents' settings files and zn's launcher files. It runs no hook, changes nothing and sends nothing.

## 1. Before anything is set up

```bash
zn-gate check --hooks
```

```text

zn hooks installed on this machine (nothing was run or changed):

  None found. To set zn up, run `npx -y zn-gate init` in your own terminal.

```

Exit code `0`. No hooks is not an error: the command only judges the hooks that exist.

## 2. Everything is fine

After `zn hooks install claude` and `zn hooks install codex`, the same command prints:

```text

zn hooks installed on this machine (nothing was run or changed):

Claude Code (user): ~/.claude/settings.json
  OK     PreToolUse [^(Bash|PowerShell|Monitor|Read|Grep|LSP|Edit|MultiEdit|Write|NotebookEdit|WebFetch)$|^mcp__.*]  '~/.zn/hooks/zn-hook-claude-code.sh' PreToolUse
  OK     PostToolUse [^(Bash|PowerShell|Monitor|Read|Grep|LSP|WebFetch|ReadMcpResourceTool)$|^mcp__.*]  '~/.zn/hooks/zn-hook-claude-code.sh' PostToolUse
  OK     UserPromptSubmit  '~/.zn/hooks/zn-hook-claude-code.sh' UserPromptSubmit
  OK     UserPromptExpansion  '~/.zn/hooks/zn-hook-claude-code.sh' UserPromptExpansion
  OK     ConfigChange  '~/.zn/hooks/zn-hook-claude-code.sh' ConfigChange
  OK     InstructionsLoaded  '~/.zn/hooks/zn-hook-claude-code.sh' InstructionsLoaded

Codex CLI (user): ~/.codex/hooks.json
  OK     PreToolUse [^(Bash|apply_patch|mcp__.+)$]  '~/.zn/hooks/zn-hook-codex.sh' PreToolUse
  OK     PermissionRequest [^(Bash|apply_patch|mcp__.+)$]  '~/.zn/hooks/zn-hook-codex.sh' PermissionRequest
  OK     PostToolUse [.*]  '~/.zn/hooks/zn-hook-codex.sh' PostToolUse
  OK     UserPromptSubmit  '~/.zn/hooks/zn-hook-codex.sh' UserPromptSubmit
  OK     SessionStart  '~/.zn/hooks/zn-hook-codex.sh' SessionStart
  OK     SubagentStart  '~/.zn/hooks/zn-hook-codex.sh' SubagentStart
  OK     Stop  '~/.zn/hooks/zn-hook-codex.sh' Stop

13 OK, 0 stale, 0 broken.

```

Exit code `0`. Read it from the top:

| Part | What it tells you |
| --- | --- |
| `Claude Code (user): ~/.claude/settings.json` | One heading per agent and settings file. `user` means the settings of your user; `project` means the settings of the folder you ran the command in. |
| `OK` | The status of one hook. It is `OK`, `STALE` or `BROKEN`, padded to the same width so the lines line up. |
| `PreToolUse` | The agent event the hook is attached to. One line per event. |
| `[^(Bash\|...)$\|^mcp__.*]` | The tools that event is limited to, as the agent's own matcher. Events with no brackets, such as `UserPromptSubmit`, run for every call. |
| `'~/.zn/hooks/zn-hook-claude-code.sh' PreToolUse` | The command the agent runs. It is zn's launcher script, followed by the event name. Long commands are cut with `...`. |
| `13 OK, 0 stale, 0 broken.` | The totals over every line. |

The plain `zn-gate check` ends with a one-line version of the same totals:

```text
Hooks: 13 OK, 0 stale, 0 broken. Run zn-gate check --hooks for details.
```

## 3. A line that says STALE

To get a `STALE` line for this page, the Codex launcher script was edited by hand (a comment line added at the end). A launcher written by an older zn-gate gives the same result.

```text
Codex CLI (user): ~/.codex/hooks.json
  STALE  PreToolUse [^(Bash|apply_patch|mcp__.+)$]  '~/.zn/hooks/zn-hook-codex.sh' PreToolUse
  STALE  PermissionRequest [^(Bash|apply_patch|mcp__.+)$]  '~/.zn/hooks/zn-hook-codex.sh' PermissionRequest
  STALE  PostToolUse [.*]  '~/.zn/hooks/zn-hook-codex.sh' PostToolUse
  STALE  UserPromptSubmit  '~/.zn/hooks/zn-hook-codex.sh' UserPromptSubmit
  STALE  SessionStart  '~/.zn/hooks/zn-hook-codex.sh' SessionStart
  STALE  SubagentStart  '~/.zn/hooks/zn-hook-codex.sh' SubagentStart
  STALE  Stop  '~/.zn/hooks/zn-hook-codex.sh' Stop
  STALE: its launcher script was written by an older zn-gate.
    Fix: run `zn hooks install codex` in your own terminal.

6 OK, 7 stale, 0 broken.
To remove the hooks of an agent instead, run `zn hooks uninstall <agent>`.
```

- Seven lines share one cause, so the explanation is printed once, under them, with the `Fix:` line. The text after `STALE:` is the reason; the command after `Fix:` is the repair.
- `STALE` means the hook still works. Run the fix when you can; it rewrites the launcher.
- The exit code is `1`: any stale or broken hook makes it non-zero.
- The line after the totals is only printed when something needs a repair. It is the way out if you do not want zn for that agent.

## 4. A line that says BROKEN

Next, the Claude Code launcher script was deleted. The six Claude Code lines read the same, so five are left out here (`...`):

```text
Claude Code (user): ~/.claude/settings.json
  BROKEN PreToolUse [^(Bash|PowerShell|Monitor|Read|Grep|LSP|Edit|MultiEdit|Write|NotebookEdit|WebFetch)$|^mcp__.*]  '~/.zn/hooks/zn-hook-claude-code.sh' PreToolUse
  ...
  BROKEN: its hook cannot start: its launcher script (~/.zn/hooks/zn-hook-claude-code.sh) is missing or was changed.
    Fix: run `zn hooks install claude-code` in your own terminal.

...

0 OK, 7 stale, 6 broken.
To remove the hooks of an agent instead, run `zn hooks uninstall <agent>`.
```

`BROKEN` means the agent's call to that hook cannot do its job: the file is missing, the hook is turned off or written twice, or the settings file is not valid JSON. Run the `Fix:` command in your own terminal and run `zn-gate check --hooks` again. When every line says `OK`, the exit code is `0` again.

## What to check

- After any `zn hooks install`, `zn-gate check --hooks` should end with `0 stale, 0 broken`.
- A `STALE` or `BROKEN` explanation always comes with a `Fix:` line: run it in your own terminal, not through your agent.
- A line you do not recognise in the list is not a zn hook. The command only lists the hooks it wrote.

## See also

- [Check that it works](../check.md): the full page, with every reason.
- [Reading a check output line by line](check-output-explained.md): the plain `zn-gate check`.
- [Uninstall one agent](uninstall-one-agent.md): remove the hooks of a single agent.
