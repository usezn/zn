# Checklist: check the hooks after an agent update

Use this after your coding agent updated itself (for example, a new version of Codex CLI or Claude Code) and you want to confirm that zn still protects it. Run every command in your own terminal, not through an agent. The example uses Codex CLI; for other agents, use the names in [Install, verify and uninstall by agent](../by-agent.md).

## 1. Run the check

```bash
npx -y zn-gate check
```

zn makes a temporary folder with a `.env` file that holds a fake key and an ordinary `README.txt`, and asks the zn hook to let the agent read each file, the same way your agent asks. An agent counts as protected only when the `.env` file is blocked and the ordinary file is allowed:

```text
  OK Codex CLI    blocked the .env file and allowed the ordinary file. Your agent would be told:
     "zn: ..."
```

After an update, the line for the updated agent may carry a version note. It compares the version of the agent on your machine with the last version zn was tested with:

```text
     version 0.170.0, newer than 0.163.0, the last version zn was tested with. It may still work. If a hook does not run, report it at https://github.com/usezn/zn/issues
```

- **Newer than tested**: the agent may still work. If a hook does not run, report it at the link in the line.
- **Older than tested**: if a hook does not run, update the agent first, then report it.
- A line that starts with `X` and says **NOT protected** gives one reason and one repair. Read the line, run the repair in your own terminal, then run `npx -y zn-gate check` again. Every reason is explained in [What each NOT protected line means](../check.md#what-each-not-protected-line-means).

## 2. List the installed hooks

```bash
zn-gate check --hooks
```

This lists every zn hook set up for your agents, one line per hook event, and says whether each one is working. It reads only the settings files of your agents and the launcher files of zn: it runs no hook, changes nothing and sends nothing. A hook whose launcher script was written by an older zn-gate is listed as STALE, with the fix to run:

```text
Codex CLI (user): ~/.codex/hooks.json
  STALE  PreToolUse [^(Bash|apply_patch|mcp__.+)$]  '~/.zn/hooks/zn-hook-codex.sh' PreToolUse
  STALE: its launcher script was written by an older zn-gate.
    Fix: run `zn hooks install codex` in your own terminal.

0 OK, 1 stale, 0 broken.
```

- **OK**: the hook points at files that exist, and its launcher is the one this zn-gate writes.
- **STALE**: the hook still works but was written by an older zn-gate, or runs an older copy of it. Run the fix the line gives.
- **BROKEN**: the hook cannot run, is turned off, is written twice for the same event, points at a file or Node.js that is gone, or is in a settings file zn cannot read. Run the fix the line gives; if you no longer want zn for that agent, run `zn hooks uninstall codex` instead.

The exit code of `zn-gate check --hooks` is `0` when every hook is OK (or none is set up) and `1` when any is stale or broken. Plain `zn-gate check` ends with one line about the same hooks:

```text
Hooks: 3 OK, 1 stale, 0 broken. Run zn-gate check --hooks for details.
```

## 3. Bring the hooks up to date

Run the fix the STALE or BROKEN line gives, in your own terminal:

```bash
zn hooks install codex
```

Replace `codex` with the agent you use; the install, verify and uninstall commands for every agent are in [Install, verify and uninstall by agent](../by-agent.md).

Two notes for the Claude Code plugin, both shown by the check itself:

- When the zn-gate plugin is a different version from the zn-gate command, the check adds a note that says which one to update: the plugin (`claude plugin update zn-gate@usezn`) when it is older, or the command (`npm install -g zn-gate@latest`) when it is older. This alone does not make Claude Code NOT protected.
- If the hooks were installed by an older zn-gate and lack the check for typed skills and commands, the check suggests running `zn hooks install claude-code` again.

For Codex CLI, zn installs its hooks with `zn hooks install codex`, and you trust them in `/hooks`: Codex ignores the hooks of a plugin until you review and trust them there, and it asks again after every plugin update.

After a zn-gate update, `npm update -g zn-gate` refreshes the launchers by itself (a short install step). You see STALE if the launcher file was edited, if the update ran with `--ignore-scripts` or with bun (which skip it), or if you installed or updated with `sudo`: run `zn hooks install <agent>` again in your own terminal to record the new files.

## 4. Run the check again

```bash
npx -y zn-gate check
```

The updated agent should be protected again: the hook blocked the fake `.env` file and allowed the ordinary file. `zn-gate check` exits with `0` only when every agent that is set up for your user is protected.

## Related

- [Check that it works](../check.md): what `zn-gate check` does and what each NOT protected line means.
- [Agent compatibility](../compat.md): the agent versions zn was tested with, and where to find your agent version.
- [Install, verify and uninstall by agent](../by-agent.md): the install, verify and uninstall commands for each agent.
- [Checklist: switching from one agent to another](switching-agents-checklist.md): when you move to a different agent instead.
