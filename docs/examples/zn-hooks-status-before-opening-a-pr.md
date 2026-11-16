# Checklist: check zn-gate before you open a pull request

Use this before you push work your coding agent helped with. Three commands tell you in a minute whether zn was watching the agent: that its hooks are in place, and that each agent you use would block a read of a secret file. Run them in your own terminal, not through an agent.

The output below comes from a test computer where only Codex CLI was set up, with a temporary home folder shortened to `~`. Your agents and numbers will differ.

## 1. Check that your agent is protected

```bash
npx -y zn-gate check
```

zn makes a temporary folder with a fake `.env` file and an ordinary file, and asks the hook of each agent you have set up to read both. The line for each agent says what happened:

```text
  OK Codex CLI    blocked the .env file and allowed the ordinary file. Your agent would be told:
     "zn: .env holds plain-text secrets, ..."
```

Agents that are not on the machine show `not found on this machine` and do not count. The command exits with `0` when every agent that is set up is protected. A line that starts with `X` and says **NOT protected** gives a reason and the command to run; fix it before you go on. Every reason is explained in [What each NOT protected line means](../check.md#what-each-not-protected-line-means).

## 2. List the hooks

```bash
npx -y zn-gate check --hooks
```

This lists every zn hook of every agent, one line per event, and says whether it works:

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

You want `0 stale, 0 broken`. The command exits with `0` when every hook is OK (or none is set up) and with `1` when any is stale or broken; the line that is not OK gives the fix. It only reads files: it runs no hook and changes nothing. With no hooks set up it says `None found.` and the command to set zn up. An example with stale hooks and their fix is in [check the hooks after an agent update](hooks-status-after-agent-update.md).

There is no `zn hooks list` or `zn hooks status`: `zn hooks` only takes `install` and `uninstall`, and `check --hooks` is the list.

## 3. Get the result as JSON, if you want to script it

```bash
npx -y zn-gate check --json
```

It prints one JSON object and nothing else, with the same exit code as the text form. These are the fields to look at (the other agents and the long message are left out here):

```json
{
  "schema": 1,
  "zn_gate_version": "1.15.0",
  "exit_code": 0,
  "protected": true,
  "agents": [
    {
      "id": "codex",
      "name": "Codex CLI",
      "state": "protected",
      "protected": true,
      "reason": "",
      "fix": ""
    }
  ]
}
```

`protected` is `true` only when the exit code is `0`. For each agent, `state` is one of `protected`, `not-protected`, `not-set-up`, `project-only` or `not-found`, and `fix` holds the command to run when something is wrong. Do not combine `--json` with `--hooks`: the command stops with exit code `2` and tells you to run them one at a time.

## Before you push

- [ ] `zn-gate check` exits with `0`.
- [ ] `zn-gate check --hooks` shows `0 stale, 0 broken`.
- [ ] You looked at what zn blocked while the agent worked: `zn-gate evidence` ([the decision log](evidence-example.md)).

For Codex CLI, an OK here does not prove that Codex runs the hooks until you have approved them once with `/hooks` inside Codex.

## See also

- [Check that it works](../check.md)
- [Check the hooks after an agent update](hooks-status-after-agent-update.md)
- [Command line reference](../cli.md#check)
- [All examples](README.md)
