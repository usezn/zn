# OpenCode

Set up zn-gate in OpenCode in two minutes, then the technical details: the plugin that runs zn's checks inside OpenCode, what it does with tool calls, tool results and chat messages, and what OpenCode does not let zn-gate cover.

## Install (no coding needed)

1. **Check that Node.js is installed.** In your own terminal, paste `node --version` and press Enter. If you see a version number, go on: zn-gate needs Node.js 18 or later. If you see "command not found", install the **LTS** version from [nodejs.org](https://nodejs.org/).

2. **Install zn-gate and turn on its protection for OpenCode.** Run every command in your own terminal. Paste each line and press Enter after each one:

   ```bash
   npm install -g zn-gate
   zn hooks install opencode
   ```

   The hooks need zn-gate 1.5 or later from npm. On a Mac, if you see `EACCES`, follow npm's guide to [fixing permission errors](https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally/). On Windows, if PowerShell says running scripts is disabled, see [the PowerShell message](../troubleshooting.md#3-running-scripts-is-disabled-on-this-system-windows).

   The install writes the plugin file `~/.config/opencode/plugins/zn-gate.js` (all your projects), or `.opencode/plugins/zn-gate.js` in one project when you run `zn hooks install opencode --project` from that project's folder. A plugin file that is there already and was not written by zn is left unchanged. The install also prints an optional hint: to let OpenCode use the secrets kept in zn's vault, add the `secrets` MCP server to `opencode.json` under `mcp`. A project plugin calls `zn` from the `PATH`, so everyone who uses the project needs zn on their `PATH`.

3. **Restart OpenCode.** OpenCode loads the plugin files in the plugins folder when it starts.

Once it works, OpenCode's agent is blocked from reading `.env` files with real values and common credential files, a secret zn-gate recognizes in your chat message is blocked before it is sent (OpenCode shows it as an error), secrets it recognizes are removed from shell output and file contents, and commands that need a stored secret are put through `zn run`.

<!-- markdownlint-disable-next-line MD029 -->
4. **If the agent says it cannot read your `.env` file** (optional): run `zn unlock` (it creates your local vault the first time), then `zn env shadow .env`. Your `.env` then holds markers instead of real values, and zn-gate fills the values in only for commands you allow.

To undo it: `zn hooks uninstall opencode`.

## What zn-gate protects in OpenCode, and what it does not

| | In OpenCode |
| - | - |
| Blocks reads of `.env` files with values, credential files (`~/.aws/credentials`, `~/.ssh/id_*`…) and `~/.zn` | Yes, for file reads and shell commands |
| Removes secrets from shell output and file contents | Yes (the tool result is rewritten in place) |
| Removes secrets from MCP tool results | Yes |
| Blocks a secret pasted into the chat | Yes (OpenCode shows it as an error) |
| Wraps a command that needs a stored secret in `zn run` | Yes (the model sees the wrapped command, including the local paths of `node` and zn — no secret value) |
| Checks a patch (`apply_patch`) | Yes: every file the patch touches is checked; a patch over 100 KB is blocked, like any long shell command |
| A change zn would ask you about | Blocked, with the way to approve it (OpenCode cannot show a question) |
| Settings that turn zn's hooks off with no sign in the agent | None in OpenCode's documentation (checked 2026-10-17) |

**Not covered:** zn never restores detected values into the arguments of a call, because OpenCode keeps the arguments it ran with in the session, where the model can read them. Live output that OpenCode stores while a command runs stays in its local database, out of the hook's reach. And as in every agent: a secret printed by a shell command, or written in a file the agent reads that is not blocked, reaches the model. Keep secrets in zn-gate's vault (`zn unlock`, then `zn env shadow .env`) so your files hold markers instead of real values: see [Scrubber](https://usezn.com/docs/zn-gate/scrubber/). Hooks are a guardrail, not a sandbox.

The OpenCode desktop app has not been tested end to end yet; the CLI has. Details and how each agent compares: [compat.md](../compat.md).

## Technical reference

### The plugin

The plugin file written by `zn hooks install opencode` sends each event to zn's hook runner on stdin and applies the answer:

- `deny`: the call or the message is blocked.
- `args`: the arguments are replaced in place (only rewrites that add no secret value: a command that needs a stored secret is wrapped in `zn run`).
- `output`: the tool output is replaced in place.
- `none`: nothing changes.

If the runner cannot be started, times out or answers something the plugin does not understand, the plugin fails closed: the tool call is blocked, the message is not sent and the tool output is withheld, for user and project installs alike. The block says so in plain words and names the repair step: run `zn-gate check` in a terminal, then `zn hooks install opencode`. The plugin waits 20 seconds for the runner. A project plugin blocks by itself when `zn` cannot start (for a teammate who cloned the project without zn-gate); a user install names the `node` and runner paths of the install that wrote it.

### The events

- `tool.execute.before`: the call is checked before it runs. Reads of secret files are blocked, and a question zn would ask is a deny with the way to approve it (OpenCode cannot show a question).
- `tool.execute.after`: secret values are replaced with `__ZN_` tokens in the output the model sees — the plain output, MCP tool results, and the preview OpenCode keeps in its local database. Output that OpenCode stored while the command was still running was written before the hook ran and is out of its reach.
- `chat.message`: the message is checked before it is stored and sent.

### Commands on Windows

On Windows, OpenCode's command tool runs in PowerShell unless the `SHELL` environment variable names another shell (measured with OpenCode 1.19.3 on Windows Server 2022: with `SHELL` unset it used PowerShell, and with `SHELL` set to Git Bash it used Git Bash). zn follows the same rule. When `SHELL` is unset, or names anything other than a bash-like shell (`bash`, `sh`, `zsh`), zn checks and wraps the command as PowerShell, the way it does for Claude Code's PowerShell tool: the command must be one program with plain arguments (no pipeline, variable or script block), and zn says so when it is not. When `SHELL` names a bash-like shell, such as Git Bash, commands are wrapped for bash as before. On macOS and Linux only an explicit `powershell` or `pwsh` in `SHELL` selects the PowerShell form. The plugin sends zn only the shell's program name (never its path) and the platform.

In our end-to-end run on Windows Server 2022 with OpenCode 1.19.3, with PowerShell a command with a marker failed instead of running — the wrapping was written for bash only then; the PowerShell wrapping added since is covered by unit tests but has not been re-run end to end. With Git Bash (`SHELL` set) it ran.

## Verify

Run `npx -y zn-gate check` in your own terminal. It makes a temporary folder with a fake `.env` file and an ordinary file, asks zn's hook to let the agent read each one, and reports whether the hook blocked the `.env` file and allowed the other. Nothing is sent over the network and no setting changes. See [Check that it works](../check.md).

For OpenCode, this checks zn's rules — the hook runner the plugin drives. The plugin itself runs inside OpenCode, which `zn-gate check` does not start. We ran OpenCode end to end with the agent itself, with 0 secret values sent to the model provider; OpenCode 1.19.3 also ran end to end on Windows Server 2022. See [Agent compatibility](../compat.md).

## Uninstall

In your own terminal:

```bash
zn hooks uninstall opencode
```

If you installed the plugin for one project only, add `--project` and run it from that project's folder. Uninstall removes the plugin file zn wrote. To remove everything at once, run `npx -y zn-gate uninstall`. See [Remove zn-gate](../uninstall.md).

## Troubleshooting

- **`node: command not found`, or Node.js is too old** (zn-gate needs 18 or later): see [Node.js is too old](../troubleshooting.md#1-nodejs-is-too-old) and [`npx: command not found`](../troubleshooting.md#2-npx-command-not-found).
- **A blocked call says the hook could not be started:** run `zn-gate check` in a terminal, then `zn hooks install opencode`.
- **A command is blocked with a note that it must be one program with plain arguments** (Windows PowerShell): the PowerShell wrapping covers only simple commands — no pipeline, variable or script block (see [Commands on Windows](#commands-on-windows) above).
- **"running scripts is disabled on this system" on Windows:** see [the PowerShell message](../troubleshooting.md#3-running-scripts-is-disabled-on-this-system-windows).

All messages: [Troubleshooting](../troubleshooting.md).

## OpenCode documentation

- Plugins: <https://opencode.ai/docs/plugins>
