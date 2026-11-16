# Example: fail a CI job when a hook is stale

After zn-gate is updated, the hooks of your coding agents can be left behind: they still run, but their launcher was written by an older zn-gate. This page shows a CI job that fails when that happens, using only `zn-gate check --hooks` and its exit code. All values are made up. For what the output means, read [List every installed hook](../check.md#list-every-installed-hook) and [Exit codes](../exit-codes.md).

## What the check does

```bash
zn-gate check --hooks
```

It lists every zn hook set up for your agents and says whether each is OK, STALE (written by an older zn-gate) or BROKEN. It only reads settings files and launcher files: it runs no hook, changes nothing and sends nothing. It looks at the settings for your user and, in the folder you run it from, at the project settings. It compares each launcher with the one the zn-gate that runs the check would write, so run it with the zn-gate you want the hooks to match.

| Exit code | Meaning |
|---|---|
| `0` | Every hook is OK, or no hook is set up. |
| `1` | At least one hook is stale or broken. |
| `2` | Wrong usage, for example `--hooks` together with `--json`. |

## Where it makes sense

The check needs hooks to look at, so use it where agents really run:

- A hosted runner starts clean and has no hooks. There the check prints `None found` and exits with `0`, so it passes without testing anything.
- A self-hosted runner, a long-lived build machine or a machine image where a coding agent works has hooks. That is where a stale hook can appear after an update, and where this job is useful.
- A repository that keeps project hooks in its settings can run the check from the checkout, because the check also reads the project settings of the folder it runs in.

CI can only look, not repair. `zn hooks install` needs a person at an interactive terminal: run by a script it is refused and exits with `77`. The repair is always a step you do yourself on that machine.

## The job

This job runs once a week on a self-hosted runner with zn-gate installed (`npm install -g zn-gate`). It runs two commands, so that the second one still runs when the first fails.

```yaml
name: zn hooks status

on:
  schedule:
    - cron: '0 6 * * 1'
  workflow_dispatch:

permissions:
  contents: read

jobs:
  hooks-status:
    runs-on: self-hosted
    timeout-minutes: 5
    steps:
      - name: Fail when a zn hook is stale or broken
        run: zn-gate check --hooks
      - name: Check that the agents are protected
        if: ${{ !cancelled() }}
        run: zn-gate check
```

The first step is the one that catches a stale hook. The second step is the normal [check](../check.md): it exits with `1` when an agent that is set up is not protected, or when none is set up.

## What the log shows

When every hook is fine, the step ends with `0`:

```text
Codex CLI (user): ~/.codex/hooks.json
  OK     PreToolUse [^(Bash|apply_patch|mcp__.+)$]  '~/.zn/hooks/zn-hook-codex.sh' PreToolUse
  OK     PermissionRequest [^(Bash|apply_patch|mcp__.+)$]  '~/.zn/hooks/zn-hook-codex.sh' PermissionRequest
  OK     PostToolUse [.*]  '~/.zn/hooks/zn-hook-codex.sh' PostToolUse
  OK     UserPromptSubmit  '~/.zn/hooks/zn-hook-codex.sh' UserPromptSubmit
  OK     SessionStart  '~/.zn/hooks/zn-hook-codex.sh' SessionStart
  OK     SubagentStart  '~/.zn/hooks/zn-hook-codex.sh' SubagentStart
  OK     Stop  '~/.zn/hooks/zn-hook-codex.sh' Stop

7 OK, 0 stale, 0 broken.
```

After the launcher was edited by hand (an update that skipped the launcher refresh looks the same), the same step ends with `1` and the job fails:

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

0 OK, 7 stale, 0 broken.
```

The `Fix:` line is the repair. Run it yourself on that machine, then run the job again.

## Why the second step is not enough

A stale hook still blocks what it blocked before, so the normal check does not notice it. In the same test, `zn-gate check` still said `OK Codex CLI` with the exit code `0`, and its last line only counted the hooks:

```text
Hooks: 0 OK, 7 stale, 0 broken. Run zn-gate check --hooks for details.
```

`zn-gate check --json` has no hooks field either: it has the fields `exit_code`, `protected` and `agents`, and `exit_code` stayed `0`. So the exit code of `check --hooks` is the one to fail the job on. `check --hooks` takes no `--json`: with both options it exits with `2`.

## Related

- [Checklist: check the hooks after an agent update](hooks-status-after-agent-update.md): the same check by hand.
- [Example: a CI job that runs the check and reads its exit code](ci-step-example.md): the audit in CI.
- [Examples](README.md): the list of all example pages.
