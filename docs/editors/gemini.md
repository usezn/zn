# Gemini CLI

Set up zn-gate in Gemini CLI in two minutes, then the technical details: the hook zn-gate installs, what Gemini CLI does and does not let zn-gate cover, and what a settings switch-off looks like.

Support for Gemini CLI is experimental. It is listed apart from the seven supported agents (see [Editors and coding agents](README.md)) and is less tested. Google replaced Gemini CLI with Antigravity CLI for free and Google One accounts on June 18, 2026; Gemini CLI keeps working with zn-gate as an experimental adapter ([Google's announcement](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/)). Run every command in your own terminal.

## Install (no coding needed)

1. **Check that Node.js is installed.** In your own terminal, paste `node --version` and press Enter. If you see a version number, go on. Node.js 22 LTS is recommended; 18 or later works for the hooks and the CLI. If you see "command not found", install the **LTS** version from [nodejs.org](https://nodejs.org/).

2. **Install zn-gate and turn on its protection for Gemini CLI.** Paste each line in the same terminal and press Enter after each one:

   ```bash
   npm install -g zn-gate
   zn hooks install gemini
   ```

   On a Mac, if you see `EACCES`, follow npm's guide to [fixing permission errors](https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally). The hooks need zn-gate 1.14.0 or later, the release that added them. zn-gate adds its hook to `~/.gemini/settings.json`.

   To protect one project only, run `zn hooks install gemini --project` from that project's folder: the hook goes into `.gemini/settings.json` there. Gemini CLI treats a project hook as untrusted until you approve it in Gemini CLI, and it runs `zn` from your PATH, so every teammate who opens the project needs zn-gate installed.

Status: checked end to end with Gemini CLI 0.64.0 against a scripted model provider, with 0 secret values sent to the model provider. On Windows Server 2022 (PowerShell 5.1) the hooks were verified to block reads of `.env` files ([compat.md](../compat.md)).

Once it works, the Gemini CLI agent is blocked from reads and writes of secret files by path, from shell commands that handle secrets, and from editing Gemini CLI's own hook or settings files.

<!-- markdownlint-disable-next-line MD029 -->
3. **If the agent says it cannot read your `.env` file** (optional): run `zn unlock` (it creates your local vault the first time), then `zn env shadow .env`. Your `.env` then holds markers instead of real values, and zn-gate fills the values in only for commands you allow.

To undo it: `zn hooks uninstall gemini`.

## What zn-gate protects in Gemini CLI, and what it does not

| | In Gemini CLI |
| - | - |
| Blocks reads and writes of secret files, by path | Yes, through the `BeforeTool` event |
| Blocks shell commands that handle secrets | Yes |
| Blocks edits of Gemini CLI's own hook or settings files | Yes |
| Removes secrets from what a tool returns | **No.** zn-gate does not use `AfterTool`, so a value printed by a command or a file the agent may read reaches the model. Keep secrets in the vault |
| Blocks a secret pasted into the chat | No. A pasted secret in a typed prompt is not checked |
| Asks you for confirmation | No. Gemini CLI hooks cannot ask: a call zn-gate would ask about is blocked, and the reason says what was held back and how to approve it (run it yourself outside the agent). A call zn-gate has no objection to gets no answer, so Gemini CLI's own approval applies |
| When the hook crashes or times out | Gemini CLI would let the call run (only an explicit refusal blocks). zn-gate blocks instead: a hook that fails is answered with a block, zn-gate sets a 15-second timeout on its hook, and a check still running after 11 seconds is answered with a block |

**Not covered:** what a tool returns is not changed, so a secret printed by a shell command or held in a file the agent may read reaches the model. Keep secrets in the zn-gate vault (`zn unlock`, then `zn env shadow .env`) so your files hold markers instead of real values: hooks are a guardrail, not a sandbox.

## Technical reference

### The hooks

`zn hooks install gemini` writes one hook entry into the Gemini CLI settings file: `~/.gemini/settings.json` for your user, or `.gemini/settings.json` in the project with `--project`. zn-gate registers the `BeforeTool` event only: it checks each tool call before it runs, and the hook entry has a 15-second timeout.

A user install writes the hook command as a small launcher script, and a project install runs `zn` from your PATH inside a start guard: when the hook fails, including when the Node.js zn-gate was installed with is gone, the launcher or the guard answers with a block instead of letting the call run. After you upgrade zn-gate, run `zn hooks install gemini` again.

Per-agent details and how each agent compares: [compat.md](../compat.md).

## Verify

Run `npx -y zn-gate check` in your own terminal. It makes a temporary folder with a fake `.env` file, asks the hook to read it, and reports whether it was blocked. Nothing is sent over the network and no setting changes. See [Check that it works](../check.md).

`zn-gate check` lists the agent as "Gemini CLI (experimental)". It also reports a launcher it cannot read (run `zn hooks install gemini` again to write it) and each Gemini CLI setting that turns the hook off (next section).

## When a Gemini CLI setting switches the hook off

These `zn-gate check` lines mean a Gemini CLI setting turned the hook off:

```text
<label> (<file>) turn all hooks off (hooksConfig.enabled is false), so zn's hook does not run. Set it to true to turn hooks on.
<label> (<file>) list zn's hook in hooksConfig.disabled (for example after `/hooks disable`), so it does not run. Remove it from that list, or run `/hooks enable zn-gate` in Gemini CLI.
change that Gemini CLI setting as it says, then run `zn-gate check` again
```

`<label>` is your Gemini CLI settings, this folder's Gemini CLI settings or the system Gemini CLI settings. With `hooksConfig.enabled` set to `false`, Gemini CLI runs no hooks at all. A name in `hooksConfig.disabled` skips just that hook. Edit the file as the line says, then run the check again. The same lines are in [Check that it works](../check.md#gemini-cli-settings-switch-the-hook-off).

A Gemini CLI settings file that zn-gate cannot read is not a NOT protected line. It adds a note under an **OK** line instead:

```text
could not read <file> (invalid JSON), so zn cannot tell whether it turns off its hooks.
```

Fix the JSON or the file permissions, then run the check again.

## Uninstall

In your own terminal:

```bash
zn hooks uninstall gemini
```

If you installed the hooks for one project only, add `--project` and run it from that project's folder. A backup of the settings file is written first. See [Remove zn-gate](../uninstall.md). To remove zn-gate from an editor by hand, see [the files zn-gate writes in each editor](remove-by-hand.md).

## Troubleshooting

- **`node: command not found`, or Node.js is too old** (zn-gate needs 18 or later): see [Node.js is too old](../troubleshooting.md#1-nodejs-is-too-old) and [`npx: command not found`](../troubleshooting.md#2-npx-command-not-found).
- **"running scripts is disabled on this system" on Windows:** see [the PowerShell message](../troubleshooting.md#3-running-scripts-is-disabled-on-this-system-windows).
- **`zn-gate check` says Gemini CLI is not protected:** a Gemini CLI setting switched the hook off (see [above](#when-a-gemini-cli-setting-switches-the-hook-off)), or the launcher cannot run: run `npm install -g zn-gate` and then `zn hooks install gemini` again.
- **A command says it needs you at your own terminal:** see [It needs you at your own terminal](../troubleshooting.md#4-it-needs-you-at-your-own-terminal).

All messages: [Troubleshooting](../troubleshooting.md).

## Gemini CLI documentation

- Hooks: <https://geminicli.com/docs/hooks/>
- Hook reference: <https://geminicli.com/docs/hooks/reference/>
- Built-in tools: <https://geminicli.com/docs/reference/tools/>
- Settings: <https://geminicli.com/docs/cli/settings/>
- Transitioning Gemini CLI to Antigravity CLI (Google's announcement): <https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/>
