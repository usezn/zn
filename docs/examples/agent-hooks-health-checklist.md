# Example: a weekly health check of your agent hooks

zn-gate only protects an agent while its hooks are installed and running. Agents update, Node.js gets replaced and settings files get edited, and any of these can quietly switch the hooks off. This page is a short checklist you can run once a week, in about a minute, with the output of each step. The output was captured from the real commands in a throwaway home folder with Claude Code and Codex CLI set up; the fix was run too. Only the times, paths and hint text differ on your machine.

There is no `zn hooks status` command. The commands that check the hooks are `zn check` and `zn check --hooks` (see [What `zn check` shows](../check.md) and [Check output explained](check-output-explained.md)). Both only read files and run a test in a temporary folder; they change nothing and send nothing.

## The checklist

1. [`zn check`](#1-zn-check): every agent you use says `OK`, and nothing says `NOT protected`.
2. [`zn check --hooks`](#2-zn-check---hooks): every hook is `OK`; none is `STALE` or `BROKEN`.
3. [`zn stats`](#3-zn-stats): the agents you used this week have counted events.
4. [Fix what is not OK](#4-fix-what-is-not-ok).

Run it also after you update an agent, replace or upgrade Node.js, or upgrade zn-gate.

## 1. `zn check`

```bash
zn check
```

Look at the lines for your agents, and the last lines (agents that are not on the machine are left out here):

```text
  OK Claude Code  blocked the .env file and allowed the ordinary file. Your agent would be told:
  OK Codex CLI    blocked the .env file and allowed the ordinary file. Your agent would be told:
     (Codex asks you to approve new hooks with /hooks before it runs them; an OK here does not prove that Codex runs the hook until you have approved it)

Hooks: 13 OK, 0 stale, 0 broken. Run zn check --hooks for details.
```

The exit code is `0` when every agent that is set up is protected. A line that starts with `X` and says `NOT protected` is the one to act on. This is the only step that notices a setting that turns hooks off. With `"disableAllHooks": true` added to the Claude Code settings, `zn check` printed:

```text
  X  Claude Code  NOT protected: ~/.claude/settings.json sets disableAllHooks, so no hooks you install run, zn's included. Remove that setting to turn them on.
```

and `zn check --hooks` still listed all hooks as `OK` (step 2), because the hooks are written correctly but the agent is told not to run them. So run step 1 first, and do not skip it.

For Codex CLI, check that you approved the hooks with `/hooks` in Codex, as the note says. In this run the hint texts printed `npx -y zn-gate@1.15.0 ...` because `zn` was not on the PATH; this page shows `zn`.

## 2. `zn check --hooks`

```bash
zn check --hooks
```

```text
Claude Code (user): ~/.claude/settings.json
  OK     PreToolUse [^(Bash|PowerShell|Monitor|Read|Grep|LSP|Edit|MultiEdit|Write|NotebookEdit|WebFetch)$|^mcp__.*]  '~/.zn/hooks/zn-hook-claude-code.sh' PreToolUse
  OK     PostToolUse [^(Bash|PowerShell|Monitor|Read|Grep|LSP|WebFetch|ReadMcpResourceTool)$|^mcp__.*]  '~/.zn/hooks/zn-hook-claude-code.sh' PostToolUse
  OK     UserPromptSubmit  '~/.zn/hooks/zn-hook-claude-code.sh' UserPromptSubmit
  OK     UserPromptExpansion  '~/.zn/hooks/zn-hook-claude-code.sh' UserPromptExpansion
  OK     ConfigChange  '~/.zn/hooks/zn-hook-claude-code.sh' ConfigChange
  OK     InstructionsLoaded  '~/.zn/hooks/zn-hook-claude-code.sh' InstructionsLoaded

Codex CLI (user): ~/.codex/hooks.json
  OK     PreToolUse [^(Bash|apply_patch|mcp__.+)$]  '~/.zn/hooks/zn-hook-codex.sh' PreToolUse
  ...

13 OK, 0 stale, 0 broken.
```

(Codex's other six lines are cut at `...`.) The exit code is `0` when all are `OK`, and `1` when any is `STALE` or `BROKEN`, so you can also run it from a script. `STALE` means the hook still works but was written by an older zn-gate; `BROKEN` means it cannot run. Both come with the command that fixes them, as shown in step 4.

## 3. `zn stats`

```bash
zn stats
```

```text
zn-gate on this machine, last 30 days (counting since 2026-11-08):

  6 events checked (prompts, tool calls and tool results)
  1 blocked (a secret file read, a pasted secret, a prompt injection or a risky call)
  0 secret values replaced before the model saw them

  By agent:
    claude-code (agent hooks): 6 events, 1 blocked, 0 replaced
```

This is a quick check that the hooks are really being called. The counts are kept on your machine. If you used an agent this week and its line is missing from `By agent` or does not grow between two checks, its hooks are not running even if steps 1 and 2 look fine. Look at the agent's own settings, and for Codex CLI at `/hooks`. See [Agent compatibility](../compat.md) for what each agent supports, and [Stats and report](stats-and-report.md) for more on this output.

## 4. Fix what is not OK

A `BROKEN` hook, made here by pointing the Codex launcher at a Node.js that no longer exists, as happens after `nvm uninstall`:

```text
Codex CLI (user): ~/.codex/hooks.json
  BROKEN PreToolUse [^(Bash|apply_patch|mcp__.+)$]  '~/.zn/hooks/zn-hook-codex.sh' PreToolUse
  ...
  BROKEN: its hook cannot start: its Node.js (~/.nvm/versions/node/v20.0.0/bin/node) is no longer there, so zn now blocks the tool calls and prompts instead of checking them.
    Fix: run `zn hooks install codex` in your own terminal.

6 OK, 0 stale, 7 broken.
```

In that state `zn check` said `X  Codex CLI    NOT protected: its hook cannot start...` and `Hooks: 6 OK, 0 stale, 7 broken.`, and both commands exit with `1`. Run the fix in your own terminal:

```bash
zn hooks install codex
```

```text
Installed zn hooks for codex in ~/.codex/hooks.json
  backup: ~/.codex/hooks.json.bak-zn-20261108T135454
```

A backup of the settings is written first. Then run `zn check --hooks` again:

```text
13 OK, 0 stale, 0 broken.
```

If you no longer want zn for that agent, run `zn hooks uninstall <agent>` instead. A `STALE` line is fixed the same way. It was not produced for this page; its text, `STALE: its launcher script was written by an older zn-gate.`, is quoted from [List every installed hook](../check.md#list-every-installed-hook), which also lists the other reasons. Each `NOT protected` reason is explained in [What each NOT protected line means](../check.md#what-each-not-protected-line-means).

## The checklist in one block

```bash
zn check          # any X line? any "disableAllHooks"?
zn check --hooks  # any STALE or BROKEN?
zn stats          # did the agents you used count events?
```
