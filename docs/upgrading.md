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

The hooks of `zn hooks install` (Claude Code, Codex CLI, Cursor) are written into
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
can leave the hook pointing at something that is gone. When the hook cannot
start:

- Prompts: Claude Code 2.1.295 or later, Cursor and OpenCode block them instead
  of letting them through unchecked. Codex CLI lets them through.
- Tool calls: in Claude Code and Codex CLI they go ahead unchecked.

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

Details on what each agent does when the hook cannot run:
[compat.md](compat.md#if-your-agent-blocks-every-prompt).

## Check that it works

```bash
zn-gate check
```

It sets up a temporary folder with a `.env` file that holds a fake key and an
ordinary file, asks each agent's installed hook to read both, and counts an agent
as protected only when the `.env` file is blocked and the ordinary file is
allowed. Nothing is sent and no setting changes. [What the output means](check.md).

## Upgrading to 1.14.0

<!-- draft: final wording follows the 1.14.0 CHANGELOG at freeze -->

This is what changes for you when you update from 1.13.x. Nothing in it stops
zn-gate from working after the update; the first two groups are things your
agent may now be refused or asked about that it was allowed to do before.

### Refused or asked by default

- **Two kinds of destructive shell command are refused.** A recursive delete of
  your home folder, the filesystem root or a system folder, and a write to a
  disk device are now blocked. The agent is told to ask you to confirm first.
  Four more rules (a download piped into a shell such as `curl ... | sh`,
  `chmod -R` or `chown -R` on a system folder, a fork bomb, and a download
  written into a shell startup file) are off by default. To change this, set
  `{"hooks": {"blockDestructiveCommands": ...}}` in `~/.zn/config.json` (`true`
  turns on all six rules, `false` turns them off, or give a list of rule names).
  See [destructive-commands.md](destructive-commands.md).
- **Claude Code asks before MCP tools receive personal data.** MCP tool calls
  are now checked before they run, as in the other agents. A secret in the
  arguments is blocked, and personal data such as an email address asks you to
  approve the call.
- **Very large or deeply nested input is no longer passed unchecked.** Text over
  256 KB is scanned in full, and text over 4 MB is blocked as too large to scan.
  Tool arguments or results nested very deeply are blocked with the reason
  "nested too deeply to check". Output that is mostly invisible characters is
  blocked quickly. If an agent starts reporting one of these, ask the tool for a
  smaller or simpler result.
- **`zn-gate uninstall` needs you.** An agent can no longer run it for you; run
  it in your own terminal, like the other commands that change your setup.
- **The audit log checks your passphrase.** It now refuses to open with the
  wrong passphrase instead of quietly writing records the right one could not
  read. Existing encrypted records are converted the first time the vault opens
  with its key.

### New experimental agents

zn-gate now supports four agents fully (Claude Code, Codex CLI, Cursor and
OpenCode) and three experimental ones. The experimental hooks are newer and
cover less, because those agents cannot do everything the others can; each one
is described in [compat.md](compat.md).

| Agent | Install |
|---|---|
| Gemini CLI | `zn hooks install gemini` |
| GitHub Copilot CLI | `zn hooks install copilot` |
| Google Antigravity | `zn hooks install antigravity` |

Add `--project` to install for one project only. Nothing changes for your
current agents unless you install these.

### New checks and warnings

- **Node.js without security fixes.** `zn-gate check` and `zn-gate status` now
  warn, without blocking, when your Node.js is end of life (18 and 20) or older
  than the patched release of its line (22.23.4, 24.22.1 or 26.12.1). The warning
  names the minimum to update to.
- **Hooks that are out of date or broken.** `zn-gate check` tells you when a
  Claude Code hook is missing, or points to a Node.js that is gone, and gives
  the command that fixes it. It also reports Codex as not protected when a hook
  is switched off or set to run in the background.
- **Output of tools is checked in Claude Code.** The output of web fetches, MCP
  tools and shell commands is checked with the local rules. When it reads like
  instructions, the agent is told to treat it as data and to tell you. This
  never blocks, and `hooks.checkToolOutputInstructions: false` turns it off.
- **More MCP checks.** `zn-gate shield` checks the other text an MCP server
  sends (not only tool results), and `zn-gate scan` and `zn audit` find keys
  written in plain text in MCP configuration files. A scan in a CI job can start
  reporting these: look at each finding and move the key into the vault or an
  environment variable.

### What to run after upgrading

1. Update the package: `npm install -g zn-gate` (and `pip install -U zn-gate`
   for the Python package).
2. Run `zn hooks install <agent>` again for each agent you use, so it gets the
   new hooks (`claude-code`, `codex`, `cursor`, `opencode`). For Codex, approve
   the changed hooks in `/hooks`. On Windows with Antigravity, this also replaces
   a hook command that could block every tool call.
3. Run `zn-gate check`. Every agent that is set up should say **OK**, and any
   warning tells you what to do.

## What each release asks you to do

Versions from 1.8.0 on. "No action" means that updating the package is enough.
For the full list of changes, see the [changelog](../CHANGELOG.md).

| Version | Date | What to do |
|---|---|---|
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
