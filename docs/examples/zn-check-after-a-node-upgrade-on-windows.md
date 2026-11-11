# Example: zn-gate check after a Node.js upgrade on Windows

You use PowerShell on Windows, you changed your Node.js (a new major version, a switch with a version manager, or a new install in another folder), and your agent now refuses every tool call and prompt with a message from zn. This page shows what `zn-gate check` says in that case, why, and the repair. Run every command in your own terminal, not through your agent.

For the same case on any system and for each agent, see [Node.js was upgraded, moved or removed](../upgrading.md#nodejs-was-upgraded-moved-or-removed-nvm-fnm-homebrew). For what each line of the check means, see [What each NOT protected line means](../check.md#what-each-not-protected-line-means).

## Why it happens

When you run `zn-gate hooks install <agent>`, zn writes the full path of the `node.exe` it ran with and of its own runner file into the hook of your agent. The check asks one thing about both: does the file still exist? A global npm package belongs to one Node.js, so a Node.js that was removed, or switched with a version manager, can take its copy of zn-gate with it.

If both files are still where they were (for example, the new Node.js was installed over the old one, in the same folder), the hook still starts and nothing changes. If one is gone, the hook cannot start. zn then blocks the tool calls and prompts of your agent instead of letting them through unchecked, so your agent stops instead of running unprotected. This is how hooks written by a recent zn-gate behave; hooks written by an earlier zn-gate and the plugins may let the calls go ahead, as the page above explains.

## 1. Run the check

```powershell
zn-gate check
```

If PowerShell says that `zn-gate` is not recognized, use `npx -y zn-gate check` instead (see the [Windows checklist](windows-checklist.md)). For an agent whose hook can no longer start, the line starts with `X` and says **NOT protected**. The exit code is `1`.

The sample below is shortened and illustrative. The sentences are the ones zn-gate prints, and the path is made up; yours is the path of the `node.exe` that zn was set up with:

```text
  X  Codex CLI    NOT protected: its hook cannot start: its Node.js (C:\Users\demo\old-node\node.exe) is no longer there, so zn now blocks the tool calls and prompts instead of checking them.
     To fix it, install zn-gate again for the Node.js you use now: run `npm install -g zn-gate`, then `zn hooks install codex`, in your own terminal.
```

If the missing file is the runner instead, the sentence names it: `its zn-gate files (<path>) is no longer there`.

## 2. See which hooks are broken

```powershell
zn-gate check --hooks
```

This lists the hooks of every agent and marks each one OK, STALE or BROKEN. It only reads files. A hook that cannot start is BROKEN, with the reason and the fix under the list (the same sentence as above, shortened here, and with the agent name of your case):

```text
  BROKEN: its hook cannot start: its Node.js (C:\Users\demo\old-node\node.exe) is no longer there, so zn now blocks the tool calls and prompts instead of checking them.
    Fix: run `zn hooks install codex` in your own terminal.

0 OK, 0 stale, 6 broken.
```

The count line is an example: it counts every hook of the agent, and the number depends on the agent. The exit code is `1` while any hook is broken. The `Fix` line is only the last step; step 3 comes first, because the old Node.js took its zn-gate with it.

## 3. Repair it

Close the PowerShell window you were using, open a new one so that it finds the Node.js you use now, and check which one that is:

```powershell
node --version
```

Then install zn-gate for this Node.js and write the hooks again:

```powershell
npm install -g zn-gate
zn-gate hooks install codex
```

Use the name of your agent in place of `codex` (the names are in [Install, verify and uninstall by agent](../by-agent.md)). Run the second command in your own terminal: it needs an interactive terminal and refuses when an agent or a script runs it. The old settings file is backed up before it changes.

Then run `zn-gate check` again. The agent line now starts with `OK`, and the command ends with exit code `0` when every agent that is set up is protected.

## A note about `zn` on the PATH

For Codex CLI, Cursor, Gemini CLI and Antigravity, the hook on Windows is a PowerShell command. When the Node.js it was set up with is gone but `zn` and `node` are both found in the absolute folders of your `PATH`, that hook runs `zn` from the PATH. The check then shows **OK**, with a note under the agent line:

```text
     (the Node.js zn was installed with is gone; the hook now runs `zn` from your PATH. Run `zn hooks install codex` to set it up again)
```

Nothing is blocked in that case, but the hook depends on your `PATH`. Run the repair above so that the hook names the Node.js you use now. Claude Code does not have this fallback: its launcher script runs only the Node.js and the runner it recorded, so it shows the **NOT protected** line.

## See also

- [Node.js was upgraded, moved or removed](../upgrading.md#nodejs-was-upgraded-moved-or-removed-nvm-fnm-homebrew): what happens for each agent, and when your agent lets calls through instead.
- [If your agent blocks every prompt](../compat.md#if-your-agent-blocks-every-prompt): why zn answers a hook that cannot start with a block.
- [Windows checklist](windows-checklist.md): install and check on Windows, step by step.
- [Checklist: check the hooks after an agent update](hooks-status-after-agent-update.md): the same check after an update of your agent.
- [What the check means](../check.md): every line of the output.
