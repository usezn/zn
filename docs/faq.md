# FAQ: update and remove zn-gate

Short answers to common questions about updating and removing zn-gate. Each
answer points to the page that has the details: [upgrading.md](upgrading.md) and
[uninstall.md](uninstall.md).

Run every command in your own terminal (the window where you type commands), not
through an AI agent. Words you do not know are in the [glossary](glossary.md).
zn-gate refuses to uninstall when an agent or a script runs it, and zn's hooks
(small checks your agent runs around its tool use) refuse
`zn hooks install` and a few other commands when an agent starts them.

## Update

### 1. How do I update zn-gate?

Run `npm install -g zn-gate` (npm is the installer that comes with Node.js; `-g`
installs it for your user account, so you can run it from any folder), and `pip install -U zn-gate` (pip is Python's
installer) if you use the Python package. Then run `zn-gate check`: every agent that is set up should say **OK**.
If you only ever run `npx -y zn-gate ...` (npx runs a package without installing
it), there is nothing to update.
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

The plugin is zn-gate's add-on for Claude Code. Update it through Claude Code's plugin manager (`/plugin` inside Claude Code), then start a
new Claude Code session. You do not run `zn hooks install` for the plugin. Do not
keep both the plugin and the hooks of `zn hooks install claude-code`, because
both would run; remove the hooks with `zn hooks uninstall claude-code`.

### 5. Codex asks me to trust the hooks again. Is that normal?

Yes. Codex (Codex CLI, a coding agent) runs a hook only after you trust it, and it asks again when a hook is
new or has changed. Open Codex and approve the hooks in `/hooks`. Until you do,
Codex does not run the new or changed hook. See
[Codex asks you to trust the hooks again](upgrading.md#codex-asks-you-to-trust-the-hooks-again).

### 6. My agent stopped being protected after I changed my Node.js. What do I do?

A global npm package belongs to one Node.js version, so `nvm use` (nvm switches Node.js versions), a Homebrew
Node.js upgrade (Homebrew is a macOS installer) or a new install can leave the hook pointing at something that is
gone. Run `npx -y zn-gate check`: it names each agent that is not protected and
the command that fixes it. Usually that is `npm install -g zn-gate`, then
`zn hooks install <agent>`. See
[Node.js was upgraded, moved or removed](upgrading.md#nodejs-was-upgraded-moved-or-removed-nvm-fnm-homebrew).

## Uninstall

### 7. How do I remove zn-gate completely?

Run `npx -y zn-gate uninstall` (or `zn-gate uninstall` if you installed it with
`npm install -g zn-gate`). It lists what it found, asks before it removes
anything, removes the plugin, the hooks and the MCP wrapping (the change that makes an MCP server, an extra tool your agent can call, start through zn's checking layer), and ends with
`zn-gate check`. Last, run `npm uninstall -g zn-gate` to remove the program, and
`pip uninstall zn-gate` if you also installed the Python package. See
[One step](uninstall.md#one-step-zn-gate-uninstall).

### 8. Can I see what uninstall would do without changing anything?

Yes. Add `--dry-run`: `npx -y zn-gate uninstall --dry-run`.

### 9. Does uninstall delete my vault or change my `.env` files?

It keeps your vault (the encrypted store of your secrets) unless you answer yes to a second, separate question (the
default is no). That yes cannot be undone. It never edits your `.env` files (project files that hold secrets). If
you moved their values into the vault with `env shadow` (it leaves markers, stand-ins for the values, in the file), put the real values back
first with `npx -y zn-gate env unshadow .env --backup <name>`. See
[Your `.env` files and the vault](uninstall.md#your-env-files-and-the-vault).

### 10. Can I remove only one part?

Yes. Remove the Claude Code plugin with `claude plugin uninstall zn-gate@usezn`,
the hooks of one agent with `npx -y zn-gate hooks uninstall <agent>`, and MCP
wrapping with `npx -y zn-gate init --revert`. Afterwards, run
`npx -y zn-gate check` to see what is left. See
[Piece by piece](uninstall.md#piece-by-piece).
