# FAQ: update and remove zn-gate

Short answers to common questions about updating and removing zn-gate. Each
answer points to the page that has the details: [upgrading.md](upgrading.md) and
[uninstall.md](uninstall.md).

Run every command in your own terminal, not through an AI agent. zn-gate refuses
to uninstall when an agent or a script runs it, and zn's hooks refuse
`zn hooks install` and a few other commands when an agent starts them.

## Update

### 1. How do I update zn-gate?

Run `npm install -g zn-gate`, and `pip install -U zn-gate` if you use the Python
package. Then run `zn-gate check`: every agent that is set up should say **OK**.
If you only ever run `npx -y zn-gate ...`, there is nothing to update.
See [the short version](upgrading.md#the-short-version).

### 2. Do I have to do anything besides updating the package?

Most releases need nothing more. Look up your old and new versions in
[the table of releases](upgrading.md#what-each-release-asks-you-to-do). If you
update from a version older than 1.8.0, go through the rows of every release in
between.

### 3. When do I run `zn hooks install <agent>` again?

When a release adds or changes a hook. The release notes in the
[changelog](../CHANGELOG.md) say so and name the agent. Running it again is safe:
it updates zn's own entries and leaves the rest of your settings alone. See
[Run `zn hooks install <agent>` again](upgrading.md#run-zn-hooks-install-agent-again-when-a-release-changes-the-hook).

### 4. How do I update the Claude Code plugin?

Through Claude Code's plugin manager (`/plugin` inside Claude Code), then start a
new Claude Code session. You do not run `zn hooks install` for the plugin. Do not
keep both the plugin and the hooks of `zn hooks install claude-code`, because
both would run; remove the hooks with `zn hooks uninstall claude-code`.

### 5. Codex asks me to trust the hooks again. Is that normal?

Yes. Codex runs a hook only after you trust it, and it asks again when a hook is
new or has changed. Open Codex and approve the hooks in `/hooks`. Until you do,
Codex does not run the new or changed hook. See
[Codex asks you to trust the hooks again](upgrading.md#codex-asks-you-to-trust-the-hooks-again).

### 6. My agent stopped being protected after I changed my Node.js. What do I do?

A global npm package belongs to one Node.js version, so `nvm use`, a Homebrew
Node.js upgrade or a new install can leave the hook pointing at something that is
gone. Run `npx -y zn-gate check`: it names each agent that is not protected and
the command that fixes it. Usually that is `npm install -g zn-gate`, then
`zn hooks install <agent>`. See
[Node.js was upgraded, moved or removed](upgrading.md#nodejs-was-upgraded-moved-or-removed-nvm-fnm-homebrew).

## Uninstall

### 7. How do I remove zn-gate completely?

Run `npx -y zn-gate uninstall` (or `zn-gate uninstall` if you installed it with
`npm install -g zn-gate`). It lists what it found, asks before it removes
anything, removes the plugin, the hooks and the MCP wrapping, and ends with
`zn-gate check`. Last, run `npm uninstall -g zn-gate` to remove the program, and
then `pip uninstall zn-gate` if you also installed the Python package. Do not
remove the program first: your agent's settings would still point at a command
that is gone. See
[One step](uninstall.md#one-step-zn-gate-uninstall).

### 8. Can I see what uninstall would do without changing anything?

Yes. Add `--dry-run`: `npx -y zn-gate uninstall --dry-run`.

### 9. Does uninstall delete my vault or change my `.env` files?

It keeps your vault unless you answer yes to a second, separate question (the
default is no). That yes cannot be undone. It never edits your `.env` files. If
you moved their values into the vault with `env shadow`, put the real values back
first with `npx -y zn-gate env unshadow .env --backup <name>`. See
[Your `.env` files and the vault](uninstall.md#4-your-env-files-and-the-vault).

### 10. Can I remove only one part?

Yes. Go in this order, with the wrapped MCP servers first and the program last.
Put back wrapped MCP servers with `npx -y zn-gate init --revert` (a saved copy
put back after the hooks are removed could bring back zn's `secrets` server),
then remove the hooks of one agent with `npx -y zn-gate hooks uninstall <agent>`,
then the Claude Code plugin with `claude plugin uninstall zn-gate@usezn`. Remove the program (`npm uninstall -g zn-gate`,
then `pip uninstall zn-gate`) only when everything else is gone. Afterwards, run
`npx -y zn-gate check` to see what is left. See
[Piece by piece](uninstall.md#piece-by-piece).

### 11. In which order should I remove zn-gate?

Remove the hooks before the program. Run `npx -y zn-gate uninstall` in your own terminal first: it puts back the MCP servers that zn-gate wrapped, then removes the hooks and the Claude Code plugin, and asks before each change. Only after that, run `npm uninstall -g zn-gate`.

If you remove the program first, the hooks stay in your agent's settings. The agent can then be blocked from running commands, because part of zn-gate is missing. If that happens, run `npm install -g zn-gate` to put the program back, then run `npx -y zn-gate uninstall`. To remove only one part, see [Piece by piece](uninstall.md#piece-by-piece).

## Your data

### 12. Where is my data?

The check runs locally on your machine unless you turn on the optional cloud check. With it on, only the text of `analyze_prompt` and `zn-gate analyze` calls is sent, after zn-gate removed the secrets it detects. See [What leaves your machine](../README.md#what-leaves-your-machine) for the full list, and [Turn on the optional cloud check](connect.md) to turn it on or off.

## Hooks

### 13. What do zn-gate's hooks do, and where do they live?

A hook is an entry that your coding agent runs at fixed points: when you send a prompt, before a tool call, and after a tool returns its output. zn-gate's hook passes that event to zn-gate, which checks it and can block it. Each agent keeps its hook entries in its own settings file: your user settings, or, with `--project`, the settings of one project folder.

To see every zn hook, the file it is in and whether it works, run `npx -y zn-gate check --hooks`. It only reads files. The small launcher script that runs the hooks is in `~/.zn/hooks`. For the command, see [`hooks`](cli.md#hooks).

### 14. How do I turn the hooks off for one project, or for a while?

For one project, go to that project's folder and run `npx -y zn-gate hooks uninstall <agent> --project`, with the agent's name, for example `claude-code`. Your user hooks stay in place.

zn-gate has no pause switch. To turn the hooks off for a while, run `npx -y zn-gate hooks uninstall <agent>`, and later run `zn-gate hooks install <agent>` to turn them back on. With the Claude Code plugin, `claude plugin disable zn-gate@usezn` turns off the plugin's hooks, and `claude plugin enable zn-gate@usezn` turns them back on.

Run these commands in your own terminal: zn-gate refuses to change hooks when an agent runs them. While the hooks are off, the agent's actions are not checked by zn-gate. Run `npx -y zn-gate check` afterwards to see what is protected.
