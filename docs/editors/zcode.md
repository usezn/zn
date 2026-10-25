# ZCode desktop app

Set up zn-gate in the ZCode desktop app from z.ai: install its hooks, and what zn-gate does and does not cover there.

## Install the hooks

In your own terminal, not through your agent:

```bash
npx -y zn-gate init
```

`init` looks for the ZCode desktop app (a `~/.zcode` folder, or a `zcode` program on your `PATH`), shows each step and asks before it runs one. To do just this step with zn-gate installed (`npm install -g zn-gate`):

```bash
zn hooks install zcode
```

This writes zn's hooks to `~/.zcode/cli/config.json` for your user, next to anything already there. It also:

- turns on `hooks.enabled`, because ZCode runs no hook while it is off (it is off by default). If it was off and you already had hooks of your own in the file, the install lists them: they run from the next ZCode session. `zn hooks uninstall zcode` puts the switch back to what it was (off or not set), unless you changed it yourself in between;
- registers the zn-gate `secrets` MCP server in the same file;
- keeps a backup of the file before it changes it.

`zn hooks uninstall zcode` removes zn's hooks and the server and leaves your own settings alone. Start a new ZCode session after installing or uninstalling: a running session keeps the hooks it started with.

There is no `--project` install. ZCode does not run the hooks of a project (`<project>/.zcode/config.json`), only the ones in your user file, so everyone on a team runs `zn hooks install zcode` once on their own machine.

Then run `npx -y zn-gate check` to see that the hook works on your machine.

## The ZCode plugin

A ZCode plugin build of zn-gate is ready. The steps to add it in ZCode (Settings, Plugins) will be published with its plugin repository. Until then the supported way to use zn-gate in ZCode is `zn hooks install zcode`, above.

What the plugin is, so you know what to expect when it is published:

- It carries its own copy of zn-gate, pinned to one release and checked against the SHA-256 of every file of the published release on each call. ZCode does not install npm packages, so there is nothing to download and nothing to go missing. It needs no account and no API key, and sends nothing over the network.
- ZCode runs the hooks of a plugin whatever `hooks.enabled` says, so the plugin keeps protecting when that switch is off. It has the same hooks as `zn hooks install zcode`.
- Its hook is a POSIX shell script. Tested on Linux with the ZCode desktop app 3.16.3; macOS is not tested. Not Windows: use `zn hooks install zcode` there. It needs Node.js 20.19 or later, or uses the one ZCode itself runs on, and blocks the call when it finds none or when anything fails. ZCode's documentation does not say what happens when a hook fails; in our tests with the ZCode desktop app 3.16.3 on Linux, a hook that failed (an exit code other than 2, a crash or a timeout) let the call run, and only exit code 2 or a deny answer blocked it.
- If Node.js hangs while the plugin hook starts, the hook still answers within 28 seconds, under the 30-second timeout the plugin sets on its hooks: it blocks the call, or only warns on events that cannot block.
- Use the plugin or `zn hooks install zcode`, not both: ZCode does not remove duplicate hooks, so every call would be checked twice. `zn hooks install zcode` warns when the plugin is on, and `zn-gate check` reports it.
- You can turn the plugin off in Settings, Plugins. With the plugin off and `hooks.enabled` false, nothing of zn runs in ZCode, and `zn-gate check` reports it as not protected. ZCode records the switch in `~/.zcode/cli/config.json` (`plugins.enabledPlugins`), which check reads.
- Tested on the ZCode desktop app on Linux only; macOS is not tested. The plugin's own files are not protected by zn's policy: code that runs as you can edit them.

## What zn-gate protects in ZCode, and what it does not

| | In ZCode |
| - | - |
| Blocks the agent from reading or writing `.env` and credential files (hooks) | Yes, once the hooks are installed |
| Blocks shell commands that handle secrets, and tells the agent to run them through `zn run` (hooks) | Yes |
| Checks the arguments of MCP tool calls before they run (hooks) | Yes: a secret value or `__ZN_` marker is blocked, personal data asks you first, and file paths get the read and write checks |
| Blocks a secret pasted into the chat | Yes: the prompt is stopped before it reaches the model (ZCode does not let a hook change a prompt, so it is blocked, not cleaned) |
| Stops the agent from editing ZCode's config file and `~/.zn` | Best effort: ZCode's file tools and shell are checked, other ways to change the file are not |
| Removes secrets from shell output and file contents | **No**: ZCode hooks cannot rewrite what a tool returns. zn adds a notice for the model when an output holds a secret |
| Works with hooks in a project | **No**: ZCode ignores them |
| zn-gate's checks available to the agent (MCP) | Yes, the `secrets` server registered on install |

Things to know:

- **Tested version.** Hooks are configured in the same user file the app documents (`~/.zcode/cli/config.json`, Settings -> Hooks), and that is where zn writes them. zn follows the hook behaviour described in the official ZCode documentation, and zn's hook is covered by automated tests. Tested end to end on the official ZCode desktop app 3.16.3 on Linux x64 (October 2026): with zn installed, Settings -> Hooks lists zn's hooks, and in a real task zn blocked reading `.env` and `~/.aws/credentials` while ordinary commands and reads ran; the same checks also passed headless with the agent the app ships. The same checks also passed on Windows x64 (Windows Server 2022, same app version, October 2026), for an administrator and for a standard user: they ran through the agent the app ships, with zn's hooks set in the app's user config file as on Linux; the Windows app window itself was not driven. **Not tested:** macOS. ZCode is a young product and can change this behaviour in a new version, so `zn-gate check` shows whether the hook works on your machine.
- **If the zn hook itself fails, ZCode can run the call.** ZCode's documentation does not say what happens when a hook fails; in our tests with the ZCode desktop app 3.16.3 on Linux, a hook that failed (an exit code other than 2, a crash or a timeout) let the call run, and only exit code 2 or a deny answer blocked it. zn covers the cases it can: its own checks answer deny and exit with code 2 if they fail or run too long, and the launcher script zn writes (`~/.zn/hooks/zn-hook-zcode.sh`) blocks the call with a message when the Node.js zn-gate was installed with is gone. The launcher also has its own deadline of 28 seconds (2 seconds under the 30-second timeout zn sets on its hook entries, on macOS, Linux and Windows): a hook that hangs while it starts is stopped and the call is blocked. A hook ZCode cannot start at all (for example the launcher file was deleted) is not covered; `zn-gate check` reports it.
- **Questions need someone to answer.** When zn would ask you first (personal data in an MCP call), ZCode needs a permission prompt to show the question. When nobody can answer a permission prompt, zn's question ends as a block and the call does not run. Not tested in the desktop app.
- **Hooks switched off.** With `"hooks.enabled": false` in `~/.zcode/cli/config.json`, ZCode runs none of the hooks in that file, zn's included (the hooks of a ZCode plugin keep running). A single entry can also be switched off with `"enabled": false`, or made to run in the background with `async`, and a background hook cannot block anything. `zn-gate check` reports all three as not protected, and `zn hooks install zcode` repairs them.
- **Values can still reach the model.** A value printed by a command, or found in a file the agent is allowed to read, is not removed. Keep secrets in the vault.
- **Subagents.** Not tested: whether ZCode runs the hooks inside its subagents.
- **Which file the agent cannot edit through its tools:** `~/.zcode/cli/config.json`. zn's policy also protects a project's `<project>/.zcode/config.json` the same way. The files of a ZCode plugin are not protected.

More detail is in the [threat model](../threat-model.md) and in [agent compatibility](../compat.md).

## ZCode documentation

- Hooks in ZCode: <https://zcode.z.ai/en/docs/hooks>
- MCP in ZCode: <https://zcode.z.ai/en/docs/mcp-services>
