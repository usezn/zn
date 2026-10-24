# Zcode (z.ai)

Set up zn-gate in Zcode, the coding agent from z.ai: install its hooks, and what zn-gate does and does not cover there.

## Install the hooks

In your own terminal, not through your agent:

```bash
npx -y zn-gate init
```

`init` looks for Zcode (a `zcode` program on your `PATH`, or a `~/.zcode` folder), shows each step and asks before it runs one. To do just this step with zn-gate installed (`npm install -g zn-gate`):

```bash
zn hooks install zcode
```

This writes zn's hooks to `~/.zcode/cli/config.json` for your user, next to anything already there. It also:

- turns on `hooks.enabled`, because Zcode runs no hook while it is off (it is off by default);
- registers the zn-gate `secrets` MCP server in the same file;
- keeps a backup of the file before it changes it.

`zn hooks uninstall zcode` removes zn's hooks and the server and leaves your own settings alone. Start a new Zcode session after installing or uninstalling: a running session keeps the hooks it started with.

There is no `--project` install. Zcode does not run the hooks of a project (`<project>/.zcode/config.json`), only the ones in your user file, so everyone on a team runs `zn hooks install zcode` once on their own machine.

Then run `npx -y zn-gate check` to see that the hook works on your machine.

## What zn-gate protects in Zcode, and what it does not

| | In Zcode |
| - | - |
| Blocks the agent from reading or writing `.env` and credential files (hooks) | Yes, once the hooks are installed |
| Blocks shell commands that handle secrets, and tells the agent to run them through `zn run` (hooks) | Yes |
| Checks the arguments of MCP tool calls before they run (hooks) | Yes: a secret value or `__ZN_` marker is blocked, personal data asks you first, and file paths get the read and write checks |
| Blocks a secret pasted into the chat | Yes: the prompt is stopped before it reaches the model (Zcode does not let a hook change a prompt, so it is blocked, not cleaned) |
| Stops the agent from editing Zcode's config file and `~/.zn` | Best effort: Zcode's file tools and shell are checked, other ways to change the file are not |
| Removes secrets from shell output and file contents | **No**: Zcode hooks cannot rewrite what a tool returns. zn adds a notice for the model when an output holds a secret |
| Works with hooks in a project | **No**: Zcode ignores them |
| zn-gate's checks available to the agent (MCP) | Yes, the `secrets` server registered on install |

Things to know:

- **Tested version.** The behaviour of Zcode's hooks was measured on zcode-cli 0.17.0 (built from the ZCode source of 20 October 2026) on Linux x64, headless (`zcode --prompt`) and in the terminal UI, with a stand-in model provider. Hooks run in every permission mode, `yolo` included. **Not tested:** Windows, macOS and the Zcode desktop app (we have not confirmed that the app reads the same config file). zn's hook is covered by automated tests built from those measurements; there is no automated end-to-end run with zn installed in Zcode yet. Zcode is a young product and can change this behaviour in a new version, so `zn-gate check` shows whether the hook works on your machine.
- **If the zn hook itself crashes, Zcode runs the call.** Zcode blocks a call only when a hook exits with code 2 or answers deny. A hook that cannot start, crashes, times out or prints something Zcode cannot read is only logged. zn covers the cases it can: its own checks answer deny and exit with code 2 if they fail or run too long, and the launcher script zn writes (`~/.zn/hooks/zn-hook-zcode.sh`) blocks the call with a message when the Node.js zn-gate was installed with is gone. A hook Zcode cannot start at all (for example the launcher file was deleted) lets the call run; `zn-gate check` reports it.
- **Questions need someone to answer.** When zn would ask you first (personal data in an MCP call), Zcode needs a permission prompt to show the question. In a run with nobody to ask, such as `zcode --prompt`, the question ends as a block and the call does not run (measured). How the question looks in the terminal UI was not tested.
- **Hooks switched off.** With `"hooks.enabled": false` in `~/.zcode/cli/config.json`, Zcode runs none of the hooks in that file, zn's included (the hooks of a Zcode plugin keep running). A single entry can also be switched off with `"enabled": false`, or made to run in the background with `async`, and a background hook cannot block anything. `zn-gate check` reports all three as not protected, and `zn hooks install zcode` repairs them.
- **Values can still reach the model.** A value printed by a command, or found in a file the agent is allowed to read, is not removed. Keep secrets in the vault.
- **Subagents.** Zcode also runs the hooks inside its subagents, so zn's checks apply to them too.
- **Which file the agent cannot edit through its tools:** `~/.zcode/cli/config.json`. The files of a Zcode plugin and a project's `.zcode` folder are not protected.

More detail is in the [threat model](../threat-model.md) and in [agent compatibility](../compat.md).

## Zcode documentation

- Hooks in Zcode: <https://zcode.z.ai/en/docs/hooks>
- MCP in Zcode: <https://zcode.z.ai/en/docs/mcp-services>
