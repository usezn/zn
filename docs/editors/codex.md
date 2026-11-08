# Codex CLI

Set up zn-gate in Codex CLI in two minutes, then the technical details: the hooks zn-gate installs, what Codex does and does not let zn-gate cover, and what to do when Codex asks you to trust the hooks again.

Codex runs a hook only after you trust it: `zn hooks install codex` writes the hooks, and you approve them in `/hooks` inside Codex. Installing zn-gate as a Codex plugin would not skip that review. Run every command in your own terminal.

## Install (no coding needed)

1. **Check that Node.js is installed.** In your own terminal, paste `node --version` and press Enter. If you see a version number, go on. Node.js 22 LTS is recommended; 18 or later works for the hooks and the CLI. If you see "command not found", install the **LTS** version from [nodejs.org](https://nodejs.org/).

2. **Install zn-gate and turn on its protection for Codex CLI.** Paste each line in the same terminal and press Enter after each one:

   ```bash
   npm install -g zn-gate
   zn hooks install codex
   ```

   On a Mac, if you see `EACCES`, follow the npm guide to [fixing permission errors](https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally). The hooks need zn-gate 1.5 or later.

3. **Trust the hooks in Codex.** Open Codex and approve the hooks in `/hooks`. Until you do, Codex does not run them, so zn-gate is not checking anything yet.

Status: verified end to end with Codex CLI 0.163.0, on Linux and on Windows Server 2022, with 0 secret values sent to the model provider ([compat.md](../compat.md)).

Once it works, the Codex agent is blocked from shell commands, patches and MCP calls that read `.env` files with real values and common credential files, a secret zn-gate recognizes in your chat message is blocked before it is sent, and secrets it recognizes are removed from tool output.

<!-- markdownlint-disable-next-line MD029 -->
4. **If the agent says it cannot read your `.env` file** (optional): run `zn unlock` (it creates your local vault the first time), then `zn env shadow .env`. Your `.env` then holds markers instead of real values, and zn-gate fills the values in only for commands you allow.

To undo it: `zn hooks uninstall codex`.

## What zn-gate protects in Codex CLI, and what it does not

| | In Codex CLI |
| - | - |
| Blocks reads of `.env` files with values, credential files (`~/.aws/credentials`, `~/.ssh/id_*`...) and `~/.zn` | Yes, for shell commands, patches and MCP call arguments. Writes are checked only for `~/.zn` and agent settings: the `apply_patch` tool of Codex may edit `.env`, while a patch sent as a shell command is refused |
| Blocks a secret pasted into the chat | Yes |
| Removes secrets from tool output | Yes, lossy: the result is replaced by its scrubbed text (Codex has no field that rewrites a result), and the Codex session log keeps the original output |
| Checks MCP tool calls before they run | Yes: a secret value or a `__ZN_` marker in the arguments is blocked. Personal data is blocked too, because Codex hooks cannot ask: the reason says what was held back and that you can run it yourself |
| Checks a call Codex is about to ask you to approve | Yes, the same check: when zn-gate would deny the call, the request is denied with the reason and no Approve button is shown |
| Reviews the final answer of the model | Warns you; the warning does not reach the model. It blocks, so Codex asks the model to rewrite the answer, only with `"stopReview": "block"` under `hooks` in `~/.zn/config.json` |
| Adds a reminder for the model at session start | Yes, context only: it checks nothing and never stops the session |

**Not covered:** a `PreToolUse` hook of another tool can answer "allow" with a changed command, and Codex then runs the changed command, which zn-gate did not check before it ran (the `PostToolUse` check still hides secret values in the output). When the zn hook cannot start at all, Codex reports a hook failure and runs the call. The Codex documentation calls the hooks "a guardrail, not an enforcement boundary". Keep secrets in the zn-gate vault (`zn unlock`, then `zn env shadow .env`) so your files hold markers instead of real values: hooks are a guardrail, not a sandbox.

## Technical reference

### The hooks

`zn hooks install codex` writes `hooks.json` in your Codex folder (`~/.codex/`, or the folder that `CODEX_HOME` names; with `--project`, `.codex/hooks.json` in the project). It installs one entry per event: `PreToolUse` (shell commands, patches and MCP calls), `PostToolUse` (scrubs tool output), `PermissionRequest` (deny only), `UserPromptSubmit`, `SessionStart` and `SubagentStart` (context only), and `Stop` (the final-answer review). A user install goes through a small launcher script (`~/.zn/hooks/zn-hook-codex.sh`), so a Node.js that has gone away blocks instead of letting the call run. On Windows the same steps are written inline in each hook command.

Optional: to let Codex use the secrets kept in the zn-gate vault, add the `secrets` MCP server to `config.toml` (your own, or the project `.codex/config.toml`); `zn hooks install codex` prints the snippet. Only that server may receive `__ZN_` placeholders.

Per-agent details and how each agent compares: [compat.md](../compat.md).

## Verify

Run `npx -y zn-gate check` in your own terminal. It makes a temporary folder with a fake `.env` file, asks the hook to read it, and reports whether it was blocked. Nothing is sent over the network and no setting changes. See [Check that it works](../check.md).

`zn-gate check` shows Codex as protected only when the hook works. It also reports a launcher whose Node.js is gone; Codex as not fully protected when your Codex folder (`hooks.json` or `config.toml`) or the project `.codex` folder holds another `PreToolUse` or `PermissionRequest` hook that is not from zn-gate; and each setting that turns the hooks off (`async`, a `[hooks.state]` entry with `enabled = false`, `[features] hooks = false`, or `allow_managed_hooks_only = true` in the requirements of your organization), with what to change.

## Uninstall

In your own terminal:

```bash
zn hooks uninstall codex
```

If you installed the hooks for one project only, add `--project` and run it from that project folder. A backup of the settings file is written first. See [Remove zn-gate](../uninstall.md).

## Codex asks you to trust the hooks again

That is normal. Codex runs a hook only after you trust it, and it asks again when a hook is new or has changed: after `zn hooks install codex` (the first time, and after any release that changes the hook), open Codex and approve the hooks in `/hooks`. Until you do, Codex does not run the new or changed hook, so zn-gate is not checking that part.

For automation that already verifies its own hooks, `codex exec --dangerously-bypass-hook-trust` skips the question for one run. Do not use it for everyday work.

More: [Codex asks you to trust the hooks again](../upgrading.md#codex-asks-you-to-trust-the-hooks-again) and [the FAQ](../faq.md#5-codex-asks-me-to-trust-the-hooks-again-is-that-normal).

## Troubleshooting

- **`node: command not found`, or Node.js is too old** (zn-gate needs 18 or later): see [Node.js is too old](../troubleshooting.md#1-nodejs-is-too-old) and [`npx: command not found`](../troubleshooting.md#2-npx-command-not-found).
- **"running scripts is disabled on this system" on Windows:** see [the PowerShell message](../troubleshooting.md#3-running-scripts-is-disabled-on-this-system-windows).
- **Codex asks you to trust the hooks again:** see [above](#codex-asks-you-to-trust-the-hooks-again).
- **`zn-gate check` says Codex is not fully protected:** another `PreToolUse` or `PermissionRequest` hook in your Codex folder or the project `.codex` folder (see Verify), a setting that turns the hooks off, or a launcher whose Node.js is gone: run `npm install -g zn-gate` and then `zn hooks install codex` again.
- **A command says it needs you at your own terminal:** see [It needs you at your own terminal](../troubleshooting.md#4-it-needs-you-at-your-own-terminal).

All messages: [Troubleshooting](../troubleshooting.md).

## Codex CLI documentation

- Hooks: <https://learn.chatgpt.com/docs/hooks>
- Repository: <https://github.com/openai/codex>
