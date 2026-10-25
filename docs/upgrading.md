# Upgrading zn-gate

What to do when you update zn-gate: which steps are always needed, which only
some releases ask for, and how to confirm that your agents are still protected.

Run every command below in your own terminal, not through an AI agent: zn's
hooks refuse `zn hooks install` and a few other commands when an agent starts
them.

## The short version

1. Update the package: `npm install -g zn-gate` (and `pip install -U zn-gate` if
   you use the Python package). If you only ever run `npx -y zn-gate ...`, there
   is nothing to update.
2. Look up your old and new versions in [the table below](#what-each-release-asks-you-to-do).
   Most releases need nothing more.
3. Run `zn-gate check`. Every agent that is set up should say **OK**.

If `zn-gate check` says an agent is not protected, it also prints the command
that fixes it.

## Run `zn hooks install <agent>` again when a release changes the hook

The hooks of `zn hooks install` (Claude Code, Codex CLI, Cursor, ZCode desktop app) are written into
the agent's own settings, so a new zn-gate does not rewrite them by itself. When
a release adds or changes a hook, the release notes in the
[changelog](../CHANGELOG.md) say so and name the agent. Run the install again
for that agent:

```bash
zn hooks install claude-code   # or codex, cursor, opencode
```

Running it again is safe: it updates zn's own entries and leaves the rest of
your settings alone. From 1.13.0, `zn-gate check` also tells you when the Claude Code hooks it
finds lack a hook that your zn-gate has.

Other cases:

- **The zn-gate plugin for Claude Code** updates through Claude Code's plugin
  manager (`/plugin` inside Claude Code). Start a new Claude Code session
  afterwards. The plugin installs the zn-gate release it is pinned to, so you do
  not run `zn hooks install` for it. Do not keep both the plugin and the hooks of
  `zn hooks install claude-code`: both would run. Remove the hooks with
  `zn hooks uninstall claude-code`.
- **OpenCode** uses a small plugin file that zn-gate writes. Run
  `zn hooks install opencode` again when a release says so.
- **Project installs** (`zn hooks install <agent> --project`) write files you can
  commit (`.claude/settings.json`, `.codex/hooks.json`, `.cursor/hooks.json`,
  `.opencode/plugins/zn-gate.js`). They call `zn` from your PATH, so they follow
  the zn-gate you have installed. Run the install again in the project when a
  release changes the hook, and commit the changed file.

## Codex asks you to trust the hooks again

Codex runs a hook only after you trust it, and it asks again when a hook is new
or has changed. After `zn hooks install codex` (the first time and after any
release that changes the hook), open Codex and approve the hooks in `/hooks`.
Until you do, Codex does not run the new or changed hook, so zn is not checking
that part. `zn-gate check` shows Codex as protected only when the hook works.

For automation that already verifies its own hooks, `codex exec
--dangerously-bypass-hook-trust` skips the question for one run. Do not use it
for everyday work.

## Node.js was upgraded, moved or removed (nvm, fnm, Homebrew)

A user install of the hooks writes the paths of the Node.js and of the zn-gate
files it was run from. A global npm package belongs to one Node.js version, so
`nvm use`, `nvm uninstall`, a Homebrew Node.js upgrade or a new Node.js install
can leave the hook pointing at something that is gone.

When zn's hook cannot start (for example, the Node.js it was installed with was
removed, and `node` or `zn` is not on the PATH of the agent), what happens
depends on the agent and on how the hooks were installed. A user install
(`zn hooks install <agent>`) writes a small launcher script as the hook command
(`~/.zn/hooks/zn-hook-<agent>.sh`; on Windows, for Codex CLI, Cursor, Gemini CLI
and Antigravity, the same steps written inline in PowerShell). It runs the
Node.js it was installed with, else `zn` from the PATH, else it answers the
block itself, without Node.js. A project install (`--project`), hooks written by
an older zn-gate and the plugins keep a plain command. Agent by agent:

- **Claude Code**: with a user install, tool calls, prompts and typed-command
  expansions are blocked in every Claude Code version; after a tool has run, zn
  only warns in the session, so that output reaches the model unscrubbed. With
  the plugin, a project install or older hooks, Claude Code 2.1.295 or later
  blocks tool calls, prompts and typed-command expansions (the hooks carry
  `onFailure: "block"`), and earlier versions let them go ahead.
- **Codex CLI**: with a user install, tool calls, prompts and permission
  requests are blocked, and after a tool has run zn only warns. With the plugin,
  a project install or older hooks, Codex reports a hook failure and carries on:
  tool calls and prompts go ahead unchecked.
- **Cursor**: with a user install, shell commands, MCP calls, file reads,
  prompts and `preToolUse` calls (Write, Delete, Grep) are blocked, and after a
  tool has run zn only warns. With the plugin, shell commands, file reads,
  prompts and `preToolUse` calls are blocked (its hooks are `failClosed`). With
  a project install or older hooks, only file reads and prompts are blocked; the
  other calls go ahead.
- **Gemini CLI**: with a user or a project install, tool calls are blocked. With
  hooks written before zn-gate 1.14.0, Gemini CLI shows a warning and the tool
  call runs.
- **GitHub Copilot CLI**: a hook command that cannot start fails closed for
  `preToolUse`, so the tool call is blocked; the hook that runs after a tool
  fails open, so that output is not scrubbed. Copilot has no launcher, and it
  lets a call through when a hook times out, so zn sets a 15-second timeout on
  its hooks and blocks the call itself at 11 seconds.
- **OpenCode**: the plugin starts the hook itself. When the hook cannot start,
  times out or gives no valid answer, the tool call is blocked, the message is
  not sent and the tool output is withheld, for user and project installs alike.
- **Antigravity**: Antigravity does not document what a hook that cannot start
  does. With a user install, the launcher answers a deny with the repair step
  (the one block Antigravity documents), so the tool call is blocked. A
  project install wraps `zn hook antigravity` in a one-line guard (`sh -c`, PowerShell on
  Windows), so a missing `zn` or `node` ends in that deny too. Only hooks installed
  by an older zn-gate keep the plain command: for those, zn-gate cannot promise
  anything (the call may be blocked with no message from zn, or run). Not tested:
  a hook that times out.
- **ZCode**: ZCode's documentation says exit code 2 or a deny answer blocks and any
  other non-zero exit code fails the hook recoverably; it does not say what happens
  when a hook cannot start or times out (not tested). With the user install (the only one
  ZCode has), the launcher exits 2 with the repair step on tool calls, permission
  requests and prompts, and after a tool has run zn only warns. The launcher also
  stops a hook that has not finished after 28 seconds (2 seconds under the 30-second
  timeout zn sets on its hook entries) and blocks the call, on Windows too. If ZCode cannot
  start the launcher itself (the file deleted or not executable), the call goes
  ahead unchecked.

`zn-gate check` says which agents are in this state.

To fix it, with the Node.js you want to keep:

1. Run `npx -y zn-gate check`. It names each agent that is not protected and the
   command that fixes it.
2. Usually that is `npm install -g zn-gate`, then `zn hooks install <agent>`. If
   you use Codex, trust the changed hooks in `/hooks` (see above).
3. With the zn-gate plugin for Claude Code, fix Node.js (the plugin needs 20.19
   or later) and start a new Claude Code session.
4. If you need your agent right away, turn zn off for it until it is fixed:
   `npx -y zn-gate hooks uninstall <agent>` (the `zn` command may be gone with the
   old Node.js), or `claude plugin disable zn-gate@usezn` for the plugin. Turn it
   back on with `zn hooks install <agent>` or
   `claude plugin enable zn-gate@usezn`, then run `zn-gate check` again.

The same text is in [compat.md](compat.md#if-your-agent-blocks-every-prompt).

## Check that it works

```bash
zn-gate check
```

It sets up a temporary folder with a `.env` file that holds a fake key and an
ordinary file, asks each agent's installed hook to read both, and counts an agent
as protected only when the `.env` file is blocked and the ordinary file is
allowed. Nothing is sent and no setting changes. [What the output means](check.md).

## What each release asks you to do

Versions from 1.8.0 on. "No action" means that updating the package is enough.
For the full list of changes, see the [changelog](../CHANGELOG.md).

| Version | Date | What to do |
|---|---|---|
| 1.14.0 | 2026-10-27 | A CI job or pre-commit hook that runs `zn-gate scan` can now exit `3` when a file was skipped (for example a JSON or Markdown file of 2 MiB or more) or when no file was read. Pass `--allow-partial` to accept skipped files (an empty scan still exits `3`); in the GitHub Action set `allow-partial: true`, and in pre-commit add `args: [--allow-partial]` to the `zn-gate-scan` hook. |
| 1.14.0 | 2026-10-27 | **A secret marker in a command's arguments is now refused**, because arguments are visible to other processes and to command-line logs. Before: `psql "postgres://user:__ZN_DB_PASSWORD__@db/app"`. After: `zn secret set PGPASSWORD --command psql`, then `zn run --secrets PGPASSWORD -- psql "postgres://user@db/app"`, where psql reads the variable itself. A secret kept for a program or a file (`env` or `file` mode) is no longer sent by `secrets_http_request`: run `zn secret allow NAME --mode proxy` if an API needs it. Approvals saved by earlier versions do not carry over: the first time a command uses a secret after you update, zn asks you to approve it again. A vault that is already unlocked while you update is restarted by `zn unlock`. |
| 1.13.0 | 2026-10-19 | If you installed Claude Code hooks with `zn hooks install claude-code`, run it again to add the hook that checks what a typed skill or command expands into (`zn-gate check` tells you; the plugin has it already). On a Node.js older than 20.12, `zn-gate init` sets up hooks instead of the plugin; if you have the plugin there, `check` gives the way out. In a GitHub workflow that uses the Action without `version`, set `version` to choose what runs: the 1.12.0 Action defaulted to 1.10.0. |
| 1.12.0 | 2026-10-18 | No action. If you verify release signatures, the signer workflow is now `build-release.yml` (see [verify-release.md](verify-release.md)). |
| 1.11.0 | 2026-10-17 | No action. A CI job that fails when `zn-gate scan` finds secrets can start failing on tokens of the new types (for example Square, Discord, Grafana or Notion tokens): look at each finding and rotate any real token. |
| 1.10.0 | 2026-10-16 | If a script runs `zn unlock` with the system keychain, it now needs an interactive terminal (`--passphrase-stdin` with the passphrase backend still works from a pipe). |
| 1.9.1 | 2026-10-16 | No action. A CI job that fails on `zn-gate scan` findings can start failing on more secret types. With Node.js older than 18, the `zn-gate` and `zn` commands stop with a message that says how to install Node.js 18 or later. |
| 1.9.0 | 2026-10-16 | If a script runs `zn-gate init` without options to wrap MCP servers, change it to `zn-gate init --wrap-mcp`: plain `init` is now a guided setup that runs only in your own terminal. |
| 1.8.2 | 2026-10-15 | No action. |
| 1.8.1 | 2026-10-15 | Update if you use the agent hooks; no other step. |
| 1.8.0 | 2026-10-15 | Run `zn unlock` once after updating: a vault still running from an older version keeps secrets as markers and tokens in the hooks until it restarts. Python 3.8 and 3.9 are no longer supported (pip there keeps installing 1.7.1). In a zn Team organization with Warn rules, do not go back to 1.7.1. |

If you are updating from a version older than 1.8.0, go through the rows of every
release in between. Older releases are in the [changelog](../CHANGELOG.md).
