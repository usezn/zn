# zn-gate in a dev container or a Codespace

A dev container is a Linux container that your editor opens your project in. GitHub Codespaces runs the same kind of container in the cloud. This page shows how to install zn-gate in one, what works without changes, what needs a setting or a habit, and what zn-gate does when the container has no system keychain (it has none).

The steps below were run on the standard Node.js dev container image (`mcr.microsoft.com/devcontainers/javascript-node:24`, Debian 13, Node.js 24, npm 11), as its non-root user `node`, with no desktop session, no D-Bus and no `secret-tool`. zn-gate was 1.16.0 from npm. All the secret values in the examples are fake.

## Short version

| What | Works in the container? |
|---|---|
| `npm install -g zn-gate`, `zn-gate --version`, `zn-gate test` | Yes, as a normal user. No `sudo` needed. |
| `zn-gate audit`, `zn-gate scan`, `zn-gate status`, `zn-gate evidence --verify`, `zn-gate stats` | Yes. Nothing leaves the container. |
| The agent hook (blocks a read of `.env`, a recursive delete of the home folder) | Yes, once your coding agent is installed in the container and zn-gate is set up for it. |
| `zn-gate init` | Yes, but it finds only the coding agents installed **inside the container**. |
| The secret vault (`zn-gate unlock`, `zn-gate secret set`) | Yes, with a **passphrase**. There is no system keychain to hold the vault key. |
| First-use approvals and policy changes from the vault | Need a setting: the container has no system dialog. See [Approvals](#approvals-need-a-terminal-of-their-own). |
| Keeping the vault across a rebuild | Not by default. See [Rebuilds](#rebuilds-and-where-the-files-live). |

## Install it

Open a terminal in the container (not on your own computer) and run:

```bash
npm install -g zn-gate
zn-gate --version
zn-gate test
```

The dev container image sets the global npm folder to a place its user owns, so this works without `sudo`. Expect a line like this from npm 11 and later:

```text
npm warn install-scripts   zn-gate@1.16.0 (postinstall: node lib/agents/refresh.js)
```

npm does not run the install script of a package until you allow it. zn-gate works without it. The script only refreshes the hook launchers after you **update** zn-gate, so after an update run `zn-gate hooks install <agent>` again (see [Upgrading](upgrading.md)).

To install it for everyone who opens the project, add the command to the dev container file `.devcontainer/devcontainer.json`:

```json
{
  "image": "mcr.microsoft.com/devcontainers/javascript-node:24",
  "postCreateCommand": "npm install -g zn-gate",
  "remoteUser": "node"
}
```

`zn-gate test` is the built-in offline check of the rules engine. It printed `51/51 vectors passed` and `ALL TESTS PASSED` in the container.

## Set it up for your coding agent

`zn-gate init` looks for coding agents in the container, not on your own computer. A container that has no agent gives:

```text
No supported coding agent was found (Claude Code, Codex CLI, Cursor, OpenCode, Antigravity, ZCode desktop app). Nothing was changed.
```

Install the agent in the container first, then run `zn-gate init` in the container's terminal. It shows each step and asks before it runs one.

For Claude Code, `init` tells you to run these inside Claude Code:

```text
/plugin marketplace add usezn/zn
/plugin install zn-gate@usezn
```

Then check that it works with `zn-gate check` (see [Check that it works](check.md)).

### What the hook does here

The hook runs the same way as on your own computer. Given a request to read a `.env` file that holds a value, it answers:

```text
zn: .env holds plain-text secrets, and secret values never go to the model (rule: secret-file:dotenv). Still holding a value: FAKE_API_KEY. Ask the user to run `zn env shadow .env` in their terminal: ...
```

Given a recursive delete of the home folder, it blocks it with the rule `destructive:rm_root_home`. The blocked actions are shown to the hook as text only: nothing was run.

## The vault without a keychain

On macOS, Windows and Linux with a desktop, zn-gate keeps the vault key in the system keychain. A dev container has none: no desktop session, no D-Bus and no `secret-tool`. Nothing needs to be installed. zn-gate uses a **passphrase** instead, as [Secrets](secrets.md) describes for any computer with no keychain.

Run this in the container's terminal. It asks for a passphrase of at least 12 characters, twice, the first time:

```bash
zn-gate unlock
```

```text
New vault passphrase (min 12 chars):
Repeat passphrase:
Created a new vault (passphrase) in /home/node/.zn/vault
Vault unlocked: locks after 30 min idle, or at 23:36 (in 8 h) at the latest. Run `zn lock` to lock now.
Note: no system dialog is available here, so first-use approvals and policy changes will be refused.
      To approve them, run the vault in a terminal of its own instead: zn lock && zn unlock --foreground
```

`zn-gate vault status` then shows `backend passphrase`. Store a value (it asks for it in the terminal, hidden):

```bash
zn-gate secret set API_TOKEN --host api.example.com
zn-gate secret list
```

```text
Value for API_TOKEN (hidden):
Stored API_TOKEN (proxy mode). Agents use it as __ZN_API_TOKEN__.
  API_TOKEN               proxy   hosts=api.example.com
```

Things to know:

- **The passphrase is yours alone.** Type it in the terminal. Do not put it in `devcontainer.json`, a Codespaces secret or a script, and nobody can recover it for you (see [If you forgot the passphrase](secrets.md)).
- **No terminal, no vault commands.** `zn-gate unlock` without a terminal stops with `zn needs a terminal to ask for the passphrase. Run this command in your terminal, or pass it with --passphrase-stdin.` and `zn-gate secret set` without one stops with `needs an interactive terminal`. `--passphrase-stdin` exists for a pipe from a secret manager you already trust. It is not a way to save a typed passphrase in a file.
- **`--backend libsecret` fails, on purpose.** Asking for the Linux keyring in a container that has no `secret-tool` prints `zn needs the secret-tool program to use your Linux keyring, and it is not installed.` and tells you to use `zn-gate unlock --backend passphrase`. The default is already the passphrase when there is no keychain, so you do not need the flag.
- **The vault locks again** after 30 minutes without use, or after 8 hours. Run `zn-gate unlock` and type the passphrase again.
- A value stored in proxy mode is never put into a process by `zn-gate run`: `zn run: Not allowed: secret API_TOKEN is in proxy mode`. Agents use the `__ZN_API_TOKEN__` marker through the `secrets` MCP server instead.

If a message does not match, see ["`zn unlock` fails on a computer with no keychain"](troubleshooting.md#zn-unlock-fails-on-a-computer-with-no-keychain).

## Approvals need a terminal of their own

The vault asks you to approve a first use of a secret or a change of policy in a system dialog. A container has none, so the unlock message says those approvals will be refused. To approve them, run the vault in a terminal of its own, in the container, and keep that terminal open:

```bash
zn-gate lock && zn-gate unlock --foreground
```

Your agent must not run this. It refuses to run under an AI agent.

## Audit a project that has a dev container

```bash
zn-gate audit .
```

A project that carries Claude Code settings with a command that starts by itself and an MCP server that runs `npx` gave:

```text
HIGH      ZNA001  .claude/settings.json:1  [claude]
          Command runs automatically from a project config
MEDIUM    ZNA003  .mcp.json:1  [claude]
          Project MCP server starts a local command
2 findings (0 critical, 1 high, 1 medium, 0 low) in 3 files. Failing: severity >= high.
```

The exit code was 1 with `--fail-on high`. `zn-gate audit . --approve` records the project's executable configuration in `~/.zn/baselines` (it asked for a terminal and recorded 3 entries), and later audits report an entry that changed.

**The commands in `.devcontainer/devcontainer.json` are not reported as findings.** `zn-gate audit --approve` records them (`initializeCommand`, `onCreateCommand`, `updateContentCommand`, `postCreateCommand`, `postStartCommand`, `postAttachCommand`), so a later change is reported, but a command such as `curl -fsSL https://example.com/setup.sh | sh` in `postCreateCommand` gave no finding. Read those fields yourself before you open a repository you do not know. `initializeCommand` runs on your own computer, outside the container.

## Rebuilds and where the files live

zn-gate keeps its files in `~/.zn` (in the examples, `/home/node/.zn`): the vault, the evidence log, the statistics, the audit approvals and the vault session. That folder lives in the container's own file system. When the container is rebuilt, it starts with an empty home folder, so you create the vault again with `zn-gate unlock` and store your values again. We have not tested keeping `~/.zn` on a volume, so this page does not give a setting for it.

Install zn-gate again after a rebuild too (the `postCreateCommand` above does it).

## Quick check list

1. `zn-gate --version` and `zn-gate test` pass in the container's terminal.
2. Your coding agent is installed in the container and `zn-gate check` shows it as protected.
3. `zn-gate unlock` created the vault with a passphrase you typed yourself.
4. `zn-gate audit .` has been read, including `.devcontainer/devcontainer.json`.
