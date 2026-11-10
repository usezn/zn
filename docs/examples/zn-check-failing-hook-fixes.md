# Example: from a failing check line to its fix

`zn-gate check` prints one line for each agent it finds. When a line does not say `OK`, it also tells you what to run. This page lists the lines you may see, grouped by what is wrong, with the command each one gives. It is a short index: the full reasons are in [What each NOT protected line means](../check.md#what-each-not-protected-line-means), and a line-by-line reading of a good output is in [Example: reading a check output line by line](check-output-explained.md).

Names in angle brackets, such as `<agent>`, stand for the agent on that line, for example `codex`. Run every fix in your own terminal, not through your agent, then run `zn-gate check` again. If you only use zn-gate through `npx`, put `npx -y zn-gate` where the commands say `zn-gate` or `zn`.

## Line starts with `-`: zn is not set up

A `-` line means zn does not protect that agent yet. This is a real output on a test machine with an empty home folder where Codex CLI and Cursor had folders but no zn hooks:

```text
  -  Codex CLI    zn is not set up for this agent. To protect it, run `npm install -g zn-gate`, then `zn hooks install codex`, in your own terminal.
     version: not found (tested with 0.163.0)
  -  Cursor       zn is not set up for this agent. To protect it, run `npm install -g zn-gate`, then `zn hooks install cursor`, in your own terminal.
     version: not found
```

The fix is the command at the end of the line. The part `npm install -g zn-gate`, then is there only when no `zn` command is on your PATH yet. The command for each agent:

| Agent | Command the line gives |
| --- | --- |
| Claude Code | `claude plugin marketplace add usezn/zn`, then `claude plugin install zn-gate@usezn` (needs internet) |
| Codex CLI | `zn hooks install codex` |
| Cursor | `zn hooks install cursor` |
| OpenCode | `zn hooks install opencode` |
| Antigravity | `zn hooks install antigravity` |
| GitHub Copilot | `zn hooks install copilot` |
| Gemini CLI | `zn hooks install gemini` |
| ZCode | `zn hooks install zcode` |

If the agent is set up only for one project, the line says `zn is set up only for one project (...)` and gives the same command; run it to protect every project.

If no agent is found at all, the output says `No supported coding agent was found on this machine`, and `npx -y zn-gate init` is the way to start. When agents are found but none is set up, it says `zn is not set up for your agents yet, so nothing protects your secrets` and points to the same `init` command, which shows each step and asks before it runs one.

## Line starts with `X`: NOT protected

An `X` line has two parts: the reason (`NOT protected: ...`) and a second line that starts `To fix it, ...`. The reasons below are the ones `zn-gate check` can print, grouped by the fix they lead to.

### Install zn-gate again for the Node.js you use now

Reasons: the hook cannot start because its Node.js or its zn-gate files are no longer there (for example after you removed a Node.js version), its launcher script is missing or was changed, zn-gate changed since the hooks were installed, the hook runs `zn` and there is no `zn` on your PATH, or the hook starts `powershell.exe` by name (written by an older zn-gate). Run both commands in your own terminal:

```bash
npm install -g zn-gate
zn hooks install <agent>
```

The line itself reads: `install zn-gate again for the Node.js you use now: run npm install -g zn-gate, then zn hooks install <agent>, in your own terminal`.

### Antigravity: a folder with a space in its path

When Antigravity cuts the hook command on spaces and the path of your home folder has a space, the line says to choose a folder with no spaces and run:

```bash
ZN_HOOK_DIR=<that folder> zn hooks install antigravity
```

### The hook is turned off

| What the line says | Fix it gives |
| --- | --- |
| Antigravity: `zn's hook is turned off in ... ("enabled": false ...)` | `zn hooks install antigravity` (it turns the hook back on), or set `"enabled"` to `true` on that hook |
| Copilot: `zn's hooks file has "disableAllHooks" turned on` | `zn hooks install copilot` (it turns the hooks back on) |
| Copilot: the Copilot settings of a folder have `"disableAllHooks"` turned on | Remove `"disableAllHooks"` from that file |
| Codex: zn's hook is switched off (`[hooks.state] enabled = false`) | Delete that `[hooks.state]` entry, or turn zn's hook back on in `/hooks` in Codex |
| Codex: zn's hook runs in the background (`async`) | Remove `async` from zn's hooks in that file, or run `zn hooks install codex` again |
| Claude Code, Codex or Gemini CLI: a setting of the agent turns hooks off | Change that setting as the line says |

After each of these, run `zn-gate check` again. Which setting each line means: [Copilot](../check.md#copilot-cli-settings-switch-the-hooks-off), [Gemini CLI](../check.md#gemini-cli-settings-switch-the-hooks-off), [Codex](../check.md#the-codex-hook-is-set-up-wrongly) and [other settings](../check.md#a-setting-turns-the-hooks-off).

### Codex: another hook runs first

`another hook runs before Codex calls (...); it can change a call after zn has checked it`. Review that hook and remove it if you do not need it, or have your administrator manage hooks with `allow_managed_hooks_only`.

### A project hook that is not the guard zn writes

For a hook in one project that is a bare `zn hook <agent>`, or that was modified, run this again in that project:

```bash
zn hooks install <agent> --project
```

### zn did not block the read of `.env`

The line says `zn did not block the read of .env`, so the zn-gate install itself needs repair. The fix:

```bash
npm install -g zn-gate
zn-gate check
```

### Claude Code plugin

| What the line says | Fix it gives |
| --- | --- |
| The plugin is turned off in your Claude Code settings | `claude plugin enable zn-gate@usezn` |
| The plugin has no `PreToolUse` hook, or its hook is not the one the plugin ships | `claude plugin uninstall zn-gate@usezn`, then `claude plugin install zn-gate@usezn` |
| The plugin starts its hook by program name | `claude plugin update zn-gate@usezn`. If the check still reports it: `npm install -g zn-gate`, then `zn hooks install claude-code`, then `claude plugin disable zn-gate@usezn` |
| The plugin needs Node.js 20.19 or later | Update Node.js to 20.19 or later, or use the hooks instead: `npm install -g zn-gate`, then `zn hooks install claude-code`, then `claude plugin disable zn-gate@usezn` |
| Git Bash was not found (Windows) | Install Git for Windows (or set `CLAUDE_CODE_GIT_BASH_PATH` to its `bash.exe`), or use the hooks instead, as in the row above |
| The plugin does not work, while the hooks of `zn hooks install claude-code` do | `claude plugin disable zn-gate@usezn` |
| The plugin and the hooks are both set up, so both run | `zn hooks uninstall claude-code` removes the second set |

Each command goes in your own terminal; then run `zn-gate check` again. Details: [Claude Code plugin](../check.md#claude-code-plugin).

### Cursor plugin

zn-gate no longer supports the Cursor plugin and reports it as NOT protected. The fix is to remove the zn-gate plugin in Cursor (Customize, in the sidebar). If the zn hooks are not set up either, the line first asks for `zn hooks install cursor` (after `npm install -g zn-gate` when `zn` is not on your PATH). More in [Cursor plugin](../check.md#cursor-plugin).

### ZCode

| What the line says | Fix it gives |
| --- | --- |
| The plugin has no `PreToolUse` hook, or it is not the one the plugin ships | Install the zn-gate plugin again in ZCode (Settings, Plugins), then run `zn-gate check` again |
| Plugins are turned off in ZCode | Turn the plugin on in ZCode (Settings, Plugins), or run `zn hooks install zcode` |
| The hook program of the plugin is not on this computer | Use `zn hooks install zcode` instead |

More in [ZCode settings switch the hook off](../check.md#zcode-settings-switch-the-hook-off).

### Managed configuration

When the zn hooks come from your administrator's managed configuration and it is wrong, the fix is not yours to make: the line says `ask your administrator to repair the managed configuration`.

### zn-gate could not finish the check

`zn could not read its setup: ...` or `zn could not check it: ...`. The other agents are still checked. For this agent, the fix is the setup command from the table above. More in [zn-gate could not finish the check](../check.md#zn-gate-could-not-finish-the-check).

## Warnings under the list

A line that starts with `Warning:` is not a failure and does not change the exit code. It is about the Node.js that runs zn-gate or the hooks. `zn-gate check --json` prints the same text under `warnings`.

## Done

Run the check again:

```bash
zn-gate check
```

It exits with 0 only when at least one agent is set up and every agent that is set up is protected. `zn-gate check --json` gives the same result for scripts, with each agent's `reason` and `fix`.

## More

- [Check that it works](../check.md)
- [Example: reading a check output line by line](check-output-explained.md)
- [Example: first block versus allow](first-block-vs-allow-decision.md)
