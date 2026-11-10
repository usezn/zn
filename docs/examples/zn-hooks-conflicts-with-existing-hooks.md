# Example: install zn's hooks next to your own hooks

You may already have hooks of your own in your coding agent: a script that checks shell commands, or one that sends you a notification. This page shows what `zn hooks install <agent>` does with them: it adds zn's hooks next to yours, never in place of them, and `zn hooks uninstall <agent>` takes out only what zn added. The commands are in the [command reference](../cli.md#hooks); the plain install steps are in [Install and uninstall the hooks of one agent](hooks-install-and-uninstall.md). Run the commands yourself, in your own terminal: they need an interactive terminal.

The files below are made-up examples, trimmed to the lines that matter. Your home folder is shown as `~`.

## 1. Start from a settings file that already has a hook

Say `~/.claude/settings.json` has one hook of yours for shell commands and one for the end of a session:

```json
{
  "model": "sonnet",
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "~/bin/my-bash-check.sh" }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "~/bin/my-notify.sh" }] }
    ]
  }
}
```

## 2. Install zn's hooks

```bash
npx -y zn-gate hooks install claude-code
```

zn writes a backup of the file first, then adds its own hook entries. Your settings and your hooks stay as they were:

```json
{
  "model": "sonnet",
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "~/bin/my-bash-check.sh" }] },
      { "matcher": "<tools zn checks>", "hooks": [{ "type": "command", "command": "'~/.zn/hooks/zn-hook-claude-code.sh' PreToolUse" }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "~/bin/my-notify.sh" }] }
    ],
    "PostToolUse": [
      { "matcher": "<tools zn checks>", "hooks": [{ "type": "command", "command": "'~/.zn/hooks/zn-hook-claude-code.sh' PostToolUse" }] }
    ]
  }
}
```

For Claude Code the install also adds zn's own `secrets` MCP server (not shown here); add `--no-mcp` to skip it. What to notice in the file:

- **Yours are untouched.** Every key and every hook of yours is still there, in the same order. zn does not edit your hook entries and does not put its command inside one of your groups.
- **zn's entry comes after yours.** It is added at the end of the list for each event, as its own entry. For an event you had no hook for (`PostToolUse` above), zn adds the event.
- **Your `Stop` hook is not changed.** zn adds nothing to it.
- **The command is zn's launcher.** zn recognises its own entries by the command they run (the launcher script under `~/.zn/hooks`, or `zn hook <agent>`), not by a label. Do not give a hook of your own a command that ends in `zn hook <agent>`: zn would take it for its own.

The file is shown with Claude Code's layout. The other agents keep their own layout, and the same rules apply (see step 5).

## 3. Install again

```bash
npx -y zn-gate hooks install claude-code
```

Running the install a second time does not add a second copy. zn first takes its own entries out, then writes them again at the end of each list, so there is still one of each. If you added another hook of your own after the first install, zn's entry moves after it. Each run writes a new backup of the file.

## 4. Remove zn's hooks

```bash
npx -y zn-gate hooks uninstall claude-code
```

zn writes a backup, then removes only the entries it recognises as its own. An event that is left empty is removed, and the `hooks` key goes if nothing is left in it. The file is back to the state in step 1: your `model` setting, your `PreToolUse` hook and your `Stop` hook. For Claude Code the uninstall also removes zn's own `secrets` MCP server, never an MCP server of yours that has the same name; add `--no-mcp` to leave MCP servers alone.

## 5. What differs by agent

| Agent | Where zn writes | Your hooks |
|---|---|---|
| `claude-code`, `codex`, `cursor`, `gemini` | The agent's settings or hooks file | Kept; zn's entries are added after yours |
| `antigravity` | A named entry called `zn-gate` in `~/.gemini/config/hooks.json` | Kept; if a hook entry of yours is already called `zn-gate`, zn uses the name `zn-gate-zn` and leaves yours alone |
| `copilot` | Its own file, `zn-gate.json`, in Copilot's `hooks` folder | Other files in that folder are not changed |
| `opencode` | Its own plugin file, `plugins/zn-gate.js` | Your other plugins are not touched |
| `zcode` | `~/.zcode/cli/config.json` | Kept; zn's entries are added after yours |

No agent is limited to one hook, so none of them makes you choose between zn and your own hooks. Four things are worth knowing:

- **OpenCode.** If a file named `zn-gate.js` is already in the plugins folder and zn did not write it, the install stops and leaves it as it is, with this message:

  ```text
  ~/.config/opencode/plugins/zn-gate.js exists and was not written by zn; left unchanged
  ```

  Rename your file and run the install again.
- **A settings file zn cannot read.** If the file is not valid JSON, or `hooks` is not an object, the install stops with a message that names the file and says it was left unchanged. Fix the file and run the install again.
- **ZCode.** ZCode runs hooks only when `hooks.enabled` is `true`, and zn turns it on. If your own hooks were there while the switch was off or missing, they start running after the install, and zn prints a warning that lists them. `zn hooks uninstall zcode` puts the switch back to what it was.
- **Project install.** With `--project`, zn does the same in the project's own file (for Claude Code, `.claude/settings.json`), where your project hooks stay and zn's entries are added after them. ZCode has no project hooks.

## 6. What zn cannot tell you

zn writes its entries and removes them, but it does not decide how your agent runs several hooks for the same call: the order, whether they run at the same time and which answer wins is the agent's choice. zn cannot see what a hook of yours does, so it cannot promise that its block holds against a hook of yours that changes the call afterwards. For Codex and Antigravity, `zn-gate check` lists other hooks that run before a call as a note. The [compatibility page](../compat.md) has what we tested for each agent.

## Done

You installed zn's hooks next to hooks of your own, saw that the install and a second install keep yours in place, and removed only zn's entries.

## Next steps

- Check that zn's hooks are set up and working: `npx -y zn-gate check --hooks` ([what the output means](../check.md#list-every-installed-hook)).
- Remove zn's hooks and confirm they are gone: [Remove the hooks, then check that they are gone](hooks-uninstall-then-verify.md).
- Another hook for Codex? See [Another hook runs next to zn's](../check.md#the-codex-hook-is-set-up-wrongly).
