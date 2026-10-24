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

- **Tested version.** Hooks are configured in the same user file the app documents (`~/.zcode/cli/config.json`, Settings -> Hooks), and that is where zn writes them. The behaviour of the hooks was measured on the ZCode agent runtime on Linux x64 (October 2026), headless and in the terminal UI, with a stand-in model provider; hooks run in every permission mode, `yolo` included. That behaviour is to be re-verified on the official desktop app. [TO UPDATE: version of the ZCode desktop app tested end to end.] **Not tested:** macOS. zn's hook is covered by automated tests built from those measurements; an end-to-end run with zn installed on that runtime (Linux) passed 15 of 15 checks, node missing and uninstall included. ZCode is a young product and can change this behaviour in a new version, so `zn-gate check` shows whether the hook works on your machine.
- **If the zn hook itself crashes, ZCode runs the call.** ZCode blocks a call only when a hook exits with code 2 or answers deny. A hook that cannot start, crashes, times out or prints something ZCode cannot read is only logged. zn covers the cases it can: its own checks answer deny and exit with code 2 if they fail or run too long, and the launcher script zn writes (`~/.zn/hooks/zn-hook-zcode.sh`) blocks the call with a message when the Node.js zn-gate was installed with is gone. The launcher also has its own deadline of 28 seconds (2 seconds under ZCode's 30-second limit, on macOS, Linux and Windows): a hook that hangs while it starts is stopped and the call is blocked, instead of running after ZCode's timeout. A hook ZCode cannot start at all (for example the launcher file was deleted) lets the call run; `zn-gate check` reports it.
- **Questions need someone to answer.** When zn would ask you first (personal data in an MCP call), ZCode needs a permission prompt to show the question. In a run with nobody to ask, such as `zcode --prompt`, the question ends as a block and the call does not run (measured). How the question looks in the terminal UI was not tested.
- **Hooks switched off.** With `"hooks.enabled": false` in `~/.zcode/cli/config.json`, ZCode runs none of the hooks in that file, zn's included (the hooks of a ZCode plugin keep running). A single entry can also be switched off with `"enabled": false`, or made to run in the background with `async`, and a background hook cannot block anything. `zn-gate check` reports all three as not protected, and `zn hooks install zcode` repairs them.
- **Values can still reach the model.** A value printed by a command, or found in a file the agent is allowed to read, is not removed. Keep secrets in the vault.
- **Subagents.** ZCode also runs the hooks inside its subagents, so zn's checks apply to them too.
- **Which file the agent cannot edit through its tools:** `~/.zcode/cli/config.json`. zn's policy also protects a project's `<project>/.zcode/config.json` the same way. The files of a ZCode plugin are not protected.

More detail is in the [threat model](../threat-model.md) and in [agent compatibility](../compat.md).

## ZCode documentation

- Hooks in ZCode: <https://zcode.z.ai/en/docs/hooks>
- MCP in ZCode: <https://zcode.z.ai/en/docs/mcp-services>
