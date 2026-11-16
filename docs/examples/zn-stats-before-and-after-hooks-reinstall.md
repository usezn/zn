# Example: stats before and after you reinstall the hooks

You want to run `zn hooks install` again, for example after an upgrade, and you wonder whether the numbers in `zn stats` start from zero. They do not. This page shows `zn stats` before and after a reinstall, with a made-up project and real output from a test run on a clean machine. Run the commands in your own terminal, not through an AI agent. Every command is in the [command reference](../cli.md#stats), and [Stats and report](stats-and-report.md) shows the other outputs.

## 1. Before any hook has run

```bash
zn hooks install claude-code
zn stats
```

```text
zn-gate on this machine, last 30 days:

  Nothing recorded yet. Counts start once zn-gate checks something (hooks, MCP tools or wrapped servers).
```

The install itself adds nothing to the counts. In the test run, the `.zn` folder held only the folder `hooks` after the first install, and no `stats.json` yet. The counts start when a hook checks a call of your agent.

## 2. After the hooks have checked some calls

In the test run, the agent asked three times to read a file in the project: twice the `.env` file (blocked) and once an ordinary `README.txt` (allowed). Then:

```bash
zn stats
```

```text
zn-gate on this machine, last 30 days (counting since 2026-11-11):

  3 events checked (prompts, tool calls and tool results)
  2 blocked (a secret file read, a pasted secret, a prompt injection or a risky call)
  0 secret values replaced before the model saw them

  By agent:
    claude-code (agent hooks): 3 events, 2 blocked, 0 replaced
```

`counting since` is the first day with a count.

## 3. Reinstall the hooks

```bash
zn hooks install claude-code
```

```text
Installed zn hooks for claude-code in ~/.claude/settings.json
  backup: ~/.claude/settings.json.bak-zn-<date>
```

The second run writes a backup of the settings file first, as every install does, and then updates zn's own entries. Look at the counts again:

```bash
zn stats
```

```text
zn-gate on this machine, last 30 days (counting since 2026-11-11):

  3 events checked (prompts, tool calls and tool results)
  2 blocked (a secret file read, a pasted secret, a prompt injection or a risky call)
  0 secret values replaced before the model saw them

  By agent:
    claude-code (agent hooks): 3 events, 2 blocked, 0 replaced
```

The numbers and the date are the same. The file that holds them, `~/.zn/stats.json`, had the same checksum before and after. The reinstall keeps your counts because the hooks and the counts are stored apart: the hooks are in your agent's settings file and in a launcher script in `~/.zn/hooks`, and the counts are in `~/.zn/stats.json`.

## 4. Remove the hooks, then install them again

```bash
zn hooks uninstall claude-code
zn hooks install claude-code
zn stats
```

`hooks uninstall` writes a backup and prints `Removed zn hooks for claude-code in ~/.claude/settings.json`. After both commands, `zn stats` still printed `3 events checked` and `2 blocked`, counting since the same day.

Nothing is counted while the hooks are removed, because zn only counts what it checks. A call your agent makes in that gap is not in the numbers, and it was not checked either. After an install, `zn check --hooks` shows that the hooks are back (see [List every installed hook](../check.md#list-every-installed-hook)).

## What changes the counts

- **More checks** add to them: every prompt, tool call and tool result that zn checks.
- **Age** removes old days: zn keeps the last 90 days of counts, and `stats` shows 30 days unless you pass `--days`.
- **`ZN_STATS=off`** turns the counts off. See the [environment variables](../cli.md#all-environment-variables).
- **Another `ZN_HOME`** moves zn's own files, the counts included, to another folder, so you see the counts of that folder.

Reinstalling or removing the hooks is not on the list. Removing zn-gate completely is described in [Remove zn-gate](../uninstall.md), which says what it deletes from the `.zn` folder.

## More

- [`stats` in the command reference](../cli.md#stats)
- [Stats and report examples](stats-and-report.md)
- [See what zn-gate did this week](../report.md)
- [Install and uninstall the hooks of one agent](hooks-install-and-uninstall.md)
