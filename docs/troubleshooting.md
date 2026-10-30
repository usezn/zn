# Troubleshooting

The eleven messages people most often meet when they first use zn-gate: what each one means and what to do. After them, [Block and warn reasons, by family](#block-and-warn-reasons-by-family) explains the other messages zn-gate prints when it stops or questions something. Each message is copied as zn-gate prints it. A part in angle brackets, such as `<agent>`, is a blank that zn fills in for you.

Run every command in your own terminal, not through your AI agent. New here? Start with [First 5 minutes](first-5-minutes.md). Words you do not know are in the [glossary](glossary.md).

## Symptom index

- [Node.js is too old](#1-nodejs-is-too-old)
- [`npx: command not found`](#2-npx-command-not-found)
- ["running scripts is disabled on this system" (Windows)](#3-running-scripts-is-disabled-on-this-system-windows)
- [It needs you at your own terminal](#4-it-needs-you-at-your-own-terminal)
- ["Your secret vault is locked"](#5-your-secret-vault-is-locked)
- [Your agent was blocked: "`.env` holds plain-text secrets"](#6-your-agent-was-blocked-env-holds-plain-text-secrets)
- [`zn-gate connect` does not accept your key](#7-zn-gate-connect-does-not-accept-your-key)
- ["will not send the saved key" (TLS settings)](#8-will-not-send-the-saved-key-tls-settings)
- [Your agent ignores zn's hooks on a managed computer](#9-your-agent-ignores-zns-hooks-on-a-managed-computer)
- ["the evidence log ... is damaged"](#10-the-evidence-log--is-damaged)
- [The Claude Code plugin rejects every call, or its MCP servers show "Failed to connect"](#11-the-claude-code-plugin-rejects-every-call-or-its-mcp-servers-show-failed-to-connect)
- [Also useful](#also-useful): TLS certificates and trust stores; npm EACCES

## 1. Node.js is too old

```text
zn-gate needs Node.js 18 or later, and this is Node.js v12.22.9.
Install the LTS version from https://nodejs.org/ (or run: nvm install --lts), then run the command again.
```

**What it means:** zn-gate is a Node.js program and your computer has a version that is too old. The version number in the message is yours and will differ.

**What to do:**

1. Install the LTS version from [nodejs.org](https://nodejs.org/), or run `nvm install --lts` if you use nvm.
2. Open a new terminal and check with `node --version`. It must say 18 or higher.
3. Run your command again.

## 2. `npx: command not found`

**What it means:** Node.js is not installed, or this terminal was opened before you installed it. `npx` and `npm` come with Node.js.

**What to do:** install the LTS version of [Node.js](https://nodejs.org/), open a new terminal and run the command again. Check with `npx --version`.

## 3. "running scripts is disabled on this system" (Windows)

**What it means:** Windows PowerShell blocks the script that starts `npm` and `npx` by default. Nothing is wrong with zn-gate.

**What to do, any one of these:**

- Use the `.cmd` versions: `npx.cmd -y zn-gate init`, or `npm.cmd install -g zn-gate`.
- Run the same commands in Command Prompt instead of PowerShell.
- Allow local scripts for your account: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

More in the [README](../README.md#install).

## 4. It needs you at your own terminal

You may see one of these:

```text
zn hooks: Not allowed: zn hooks install needs an interactive terminal. Open a terminal window yourself and run it there.
zn env: Not allowed: zn env shadow needs an interactive terminal. Open a terminal window yourself and run it there.
zn-gate connect needs an interactive terminal. Open a terminal window yourself and run it there.
<command> must be run by you in your own terminal, not by an AI agent (detected CLAUDECODE).
An AI agent is running this, so zn only prints the steps: installing hooks is your decision. Nothing was changed.
```

**What it means:** some steps change your settings or touch your secrets, so zn only runs them when a person types them. It refuses when your AI agent runs them, or when a script runs them with nobody at the keyboard. This is on purpose. Nothing was changed.

**What to do:** open a terminal window yourself (not the agent's window) and run the same command there. If you only see "started from ...", zn thinks an agent is above your terminal in the process chain. Open a fresh terminal window from your system menu and try again. For `init`, the steps printed under the message are the commands to run.

## 5. "Your secret vault is locked"

```text
Your secret vault is locked. Unlock it in this terminal with: zn unlock. Then run this command again.
```

**What it means:** zn keeps the real values of your secrets in an encrypted vault, and the vault is closed. It locks itself after 30 minutes without use, after 8 hours at most, or when you restart your computer. If `zn` is not installed on your computer, the message gives the `npx -y zn-gate@<version> unlock` form instead.

**What to do:**

1. Run `zn unlock` in your own terminal. It may ask for a passphrase. Type it yourself: zn never reads it from your agent.
2. Run `zn vault status` to see that it says unlocked.
3. Run the command that failed again.

More in [secrets](secrets.md). If it asks for a terminal to enter the passphrase and you have none (for example over SSH), see "If something fails" there.

**If the passphrase is right but the vault will not open:** `zn unlock` says so when the vault file is damaged or the system keychain refuses. It then names the damaged file and tells you to restore it from a backup first. Do not run `zn vault reset` before you try that: it would delete values that may still be fine. Run `zn vault verify` to see whether the vault files are intact, restore the vault folder from a backup if you have one, or sign in to the user account that created the vault. With no backup, `zn vault reset` is the way out: it sets the old vault aside and starts empty, so the values saved in it are lost. If a keychain is the cause, the message names it.

**If the keychain refuses:** `unlock` names the one your computer uses and one next step. On macOS, choose Allow in the Keychain window, or open Keychain Access and allow zn to use the item `zn-vault`. On Windows, check that Credential Manager works for your account (open it from the Start menu). On Linux, make sure your keyring is unlocked by logging in to your desktop session; if the `secret-tool` program is missing, install the `libsecret-tools` package (for example `sudo apt install libsecret-tools`). When the vault is being created, you can use a passphrase instead: `zn unlock --backend passphrase`. For the technical code that the keychain returned, run the command again with `ZN_VERBOSE=1`.

**If the vault does not answer:** "The vault is not answering" means the vault is slow or was left over from a crash. Run `zn lock`, then `zn unlock`. If `unlock` says the vault did not start in time or stopped while starting, run it again; if it keeps happening, restart your computer and open an issue with the output of `ZN_VERBOSE=1 zn unlock`.

**If `zn vault verify` says the audit log did not pass its check:** do not delete or edit the log. It is the record of what the vault did, and a change to it is what the check finds. Keep a copy of `~/.zn/audit.jsonl`, then open an issue; `zn vault verify` with `ZN_VERBOSE=1` prints the reason. If the message says the log "was changed behind the vault", and you have looked into it (for example you know a disk problem or a restore cut the log), run `zn vault verify --acknowledge` in your own terminal to accept the log as it is now; the warning stays in the log. If it says the log "does not verify on its own", the chain itself is broken and cannot be accepted.

**If you forgot the passphrase:** nobody can recover it, zn included. That is what keeps your secrets safe. After three wrong passphrases in a row (other errors do not count), `zn unlock` points you to the way out:

```text
Forgot the passphrase? `zn vault reset` starts a new, empty vault (the old values are lost).
```

1. Run `zn lock` if the vault is unlocked, then run `zn vault reset` in your own terminal. It does nothing in a script or when your AI agent runs it.
2. Read what it says, then type `reset my vault` and press Enter. Anything else cancels and changes nothing.
3. zn saves the old vault in a folder named `vault-backup-<date>-<time>` inside your zn folder (`~/.zn`), then removes it. The values stored in it are lost, because only the old passphrase opens them. If you find the passphrase later, the backup still opens with it. The reset never deletes that backup: when you no longer need it, run `zn vault purge` in your own terminal. It lists every file (the vault, token maps, backups and session key), asks you to type `purge my vault`, deletes them and checks that none is left.
4. Run `zn unlock` to create the new vault, then store your values again, for example `zn env shadow .env` or `zn secret set NAME`. Rotate any secret you cannot re-enter from another source.

If your computer is part of a zn Team organization, `zn vault reset` refuses, because a reset would remove the organization's controls. Ask your administrator.

## 6. Your agent was blocked: "`.env` holds plain-text secrets"

```text
zn: .env holds plain-text secrets. Ask the user to run `zn env shadow .env` in their terminal: it moves the values to the local vault and leaves __ZN_<NAME>__ markers you can read and use.
```

**What it means:** your agent tried to read a file with secrets in plain text. zn stopped it, so the secrets did not reach the agent. This is zn working, not an error.

**What to do:**

1. If the agent needs a value from that file, run `zn env shadow .env` yourself in your own terminal. The values move to the vault and the file keeps markers such as `__ZN_API_KEY__` that the agent can use.
2. If you did not expect the read, ask your agent why it wanted that file, and do not look for a way around the block.
3. To put your old `.env` back, run the restore command that `zn env shadow` printed, for example `zn env unshadow .env --backup <name>`.

More in [secrets](secrets.md) and [what the check means](check.md).

## 7. `zn-gate connect` does not accept your key

`connect` prints its problems on the error output. If the message says "Could not reach usezn.com", check your internet connection and run `zn-gate connect` again. If it says usezn.com "is not answering properly right now", wait a few minutes and try again. In both cases nothing was saved. If it says the computer has no system keychain and the vault is locked, run `zn unlock` (it asks for a passphrase), then `zn-gate connect` again.

```text
That does not look like a zn API key (they start with zn_). Nothing was saved. Run `zn-gate connect` and paste the key again.
usezn.com did not accept this key (it may be revoked or mistyped). Nothing was saved. Run `zn-gate connect` and paste a valid key.
This key can do more than analyze text, and zn-gate only accepts a key limited to analyzing. Create an analysis-only key on the connect page and paste that one: <connect page address>
Nothing was saved.
```

**What it means:** `connect` is optional and turns on the cloud check. It saves a key only if the key is an analysis-only key that works. The message says which part failed. Nothing was saved, so nothing needs undoing.

**What to do:**

1. Create a new analysis-only key on the connect page named in the message. Do not use a full-access key.
2. Run `zn-gate connect` and paste the key at the hidden prompt. Never put the key on the command line.
3. To turn the cloud check off at any time: `zn-gate disconnect`.

More in [connect](connect.md). You do not need `connect` to use zn-gate: without it everything stays on your machine.

## 8. "will not send the saved key" (TLS settings)

```text
NODE_TLS_REJECT_UNAUTHORIZED is set in this terminal, so zn-gate will not send the saved key: it switches off the check that the connection really goes to usezn.com. Remove it (macOS or Linux: `unset NODE_TLS_REJECT_UNAUTHORIZED`; Windows PowerShell: `Remove-Item Env:NODE_TLS_REJECT_UNAUTHORIZED`) and try again.
```

**What it means:** your terminal has a setting that turns off the check of website certificates, changes how secure connections work, or could print or read your key. zn-gate refuses to send your saved key through such a connection. While you connect (nothing is saved yet) the message says "the key" instead of "the saved key". Similar messages name `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `OPENSSL_CONF`, `NODE_DEBUG` or `NODE_OPTIONS` instead. Your local checks keep working.

**What to do:** zn-gate refuses on purpose: with that setting, someone between you and usezn.com could read your key. Nothing is broken, and the local checks keep working without the cloud check.

- If you set it yourself, for example for a test, remove it, open a new terminal and try again. On macOS or Linux, `unset NODE_TLS_REJECT_UNAUTHORIZED` (or the name in the message) removes it for this terminal; in Windows PowerShell, `Remove-Item Env:NODE_TLS_REJECT_UNAUTHORIZED`. If it comes back, look in your shell startup file (such as `~/.zshrc` or `~/.bashrc`).
- If your company needs it, for example for a proxy with its own certificate, keep it and ask your administrator. Until then zn-gate uses only its local checks on this computer.
- Never turn off certificate checks to make this message go away.

## 9. Your agent ignores zn's hooks on a managed computer

```text
Your organization's Claude Code policy (<file>) turns off all hooks (disableAllHooks), so zn's hooks do not run. Claude Code does not show this. Ask your administrator to add zn to the managed settings.
```

Other versions say that the policy "runs only the hooks in its managed settings (allowManagedHooksOnly)", that a settings file of yours "sets disableAllHooks", or that a managed MCP list does not include zn's "secrets" server.

**What it means:** a setting stops zn's hooks from running. Usually your company or school controls Claude Code's settings; sometimes it is a line in your own settings file. Claude Code itself shows no warning, so zn tells you when you install hooks or run `npx -y zn-gate check` or `npx -y zn-gate status`. Until this is fixed, zn is not protecting that agent.

**What to do:**

- If the message names your own settings file, that line turns off every hook you install, zn's included. Remove the `disableAllHooks` line, unless you set it on purpose, and run `npx -y zn-gate check`.
- If it names an organization policy, ask your administrator to add zn to the managed settings. Send them the message.
- Run `npx -y zn-gate check` to see which agents are protected.

More in [compat](compat.md).

## 10. "the evidence log ... is damaged"

```text
zn-gate: the evidence log <path> is damaged (<reason>) Events are not being recorded. Run 'zn-gate evidence --verify' for details. To start a new log and keep the old file for review, move it aside (mv "<path>" "<folder>/evidence.damaged.jsonl"); the next event starts a new chain.
```

**What it means:** zn-gate keeps a log of what it decided. Each line is linked to the one before, so a line that was edited, cut off or half written breaks the chain. zn does not repair a log: it stops writing to it so it never hides the damage. Your protection keeps working. Only the record stops.

**What to do:**

1. Run `npx -y zn-gate evidence --verify`. It says where the break is.
2. Keep the old file if you need it for review. Move it aside with the command in the message. On Windows the message shows a `move` command instead of `mv`.
3. The next event starts a new log. Run `npx -y zn-gate evidence --verify` again to see that it is fine.

## 11. The Claude Code plugin rejects every call, or its MCP servers show "Failed to connect"

You may see one of these:

```text
Failed to connect: CONNECTION_CLOSED
```

```text
X  Claude Code   NOT protected: the zn-gate plugin needs Node.js 20.19 or later (you have 18.19.1).
   To fix it, update Node.js to 20.19 or later (the current LTS from nodejs.org), and make it the first `node` on your PATH, or use zn's hooks instead: run `npm install -g zn-gate`, then `zn hooks install claude-code`, and after that turn the plugin off with `claude plugin disable zn-gate@usezn`, all in your own terminal.
```

The version number in the second message is yours and will differ.

**What it means:** the zn-gate plugin for Claude Code needs Node.js 20.19 or later. With an older Node.js (for example Node.js 18, which `apt` installs on many Debian and Ubuntu systems), the plugin refuses to start on purpose: its checks block the calls they cannot make. Before version 1.14.0 the plugin also had MCP servers, which did not start either, so Claude Code listed them as failed to connect. zn-gate itself and zn's hooks still run on Node.js 18 and later. Nothing is wrong with your files.

**How to check:**

1. Run `node --version` in your own terminal. If it says a version lower than 20.19 (such as `v18.19.1`), this is the cause. Claude Code starts the plugin with the first `node` on its `PATH`, so use the terminal you start Claude Code from.
2. Run `npx -y zn-gate check`. A line for Claude Code that says `NOT protected: the zn-gate plugin needs Node.js 20.19 or later` confirms it.

**What to do, either one:**

- **Update Node.js (recommended):** install the Node.js 22 LTS version from [nodejs.org](https://nodejs.org/), open a new terminal, check that `node --version` shows it, then start a new Claude Code session. On a computer with several Node.js installs, make sure the new one is the first on your `PATH`.
- **Or use zn's hooks instead of the plugin:** run `npm install -g zn-gate`, then `zn hooks install claude-code`, then `claude plugin disable zn-gate@usezn`, all in your own terminal. Then run `npx -y zn-gate check` again.

Running `npx -y zn-gate init` on a Node.js older than 20.19 does the second option for you: it skips the plugin and sets up zn's hooks for Claude Code instead, and if the plugin is already installed it offers to turn it off once the hooks work. Node.js 22 LTS is recommended; 18 or later is enough for the hooks and the CLI. See the [README](../README.md#install).

## Block and warn reasons, by family

Past the eleven messages above, zn-gate prints more short messages when it stops or questions something. This part explains each one in the same three steps: what happened, whether it is safe, and what to do. A message that starts with `zn:` or `zn blocked this:` came from zn's hooks. Your agent reads it first, and you often see it in your agent's window. Quotes below give the start of each message. A part in angle brackets, such as `<file>`, is a blank that zn fills in.

Run every command in your own terminal, not through your AI agent. If you did not install zn-gate with `npm install -g zn-gate`, put `npx -y zn-gate` where the commands below say `zn`, for example `npx -y zn-gate secret set NAME`. Words you do not know are in the [glossary](glossary.md).

Pick the family that fits your message:

- [Your agent tried to read or change a protected file](#your-agent-tried-to-read-or-change-a-protected-file)
- [Your agent tried to run a command only you may run](#your-agent-tried-to-run-a-command-only-you-may-run)
- [A command that wipes or damages the machine](#a-command-that-wipes-or-damages-the-machine)
- [A secret was used the wrong way in a command](#a-secret-was-used-the-wrong-way-in-a-command)
- [A request would send personal data or a secret away](#a-request-would-send-personal-data-or-a-secret-away)
- [A command, patch or output was too big or too complicated to check](#a-command-patch-or-output-was-too-big-or-too-complicated-to-check)
- [A secret or odd text showed up in output, a prompt or an answer](#a-secret-or-odd-text-showed-up-in-output-a-prompt-or-an-answer)
- [zn could not read what your agent asked for, or could not run](#zn-could-not-read-what-your-agent-asked-for-or-could-not-run)
- [Messages about other tools (MCP servers and shield)](#messages-about-other-tools-mcp-servers-and-shield)
- [A rule blocked text that looked like an attack](#a-rule-blocked-text-that-looked-like-an-attack)
- [Messages from commands you run yourself](#messages-from-commands-you-run-yourself)

### Your agent tried to read or change a protected file

#### "zn: `<file>` was not read because zn treats it as holding secrets (`<kind>`)"

**What happened:** your agent tried to read a file that usually holds a password or key. The kind in brackets says which: an SSH private key, a private key file, a key store, `~/.npmrc` or `~/.pypirc` ("package registry token", a token for npm or PyPI), or a file named by a credential setting.

**Is it safe?** Yes. The file was not read, so its contents never reached the agent.

**What to do:** if a command needs a value from that file, store it with `zn secret set NAME` in your own terminal. Your agent then runs the command with `zn run --secrets NAME -- <command>`, and the program gets the value as an environment variable on your computer. If you did not expect the read, ask your agent why it wanted that file. See [secrets](secrets.md). A `.env` file has its own message: see [section 6](#6-your-agent-was-blocked-env-holds-plain-text-secrets).

#### "zn: this command reads `<file>` through a path zn cannot check" / "builds the path of a .env file while it runs" / "changes to `<folder>` first"

**What happened:** your agent ran a command that reaches a `.env` or key file in a way zn cannot follow: a path on a Windows drive root or a network share, a path assembled while the command runs, or a move into a folder zn cannot follow before the read.

**Is it safe?** Yes. zn blocks what it cannot check, so nothing was read.

**What to do:** ask your agent to name the file directly from the current folder, for example `cat app/.env`. If the file holds values, run `zn env shadow .env` in that folder, in your own terminal, so the agent sees markers instead.

#### "zn: this search covers a folder that holds `<file>`, which has plain-text secrets"

**What happened:** your agent started a search over a folder that contains a `.env` file or key file, and this agent cannot hide matching lines. zn asks you instead of blocking. A similar question appears when a recursive search names its folder through a variable, or after many folder changes, so zn cannot tell which folders it covers.

**Is it safe?** It is safe if you decline. If you approve, the matching lines, secrets included, can be shown to the model.

**What to do:** decline, and ask the agent to search a narrower folder. Approve only if the search must include that file. To protect the values for the future, run `zn env shadow .env`.

#### "zn: this git command reads the stored content or history of `<file>`" / "zn: `<ref>:<file>` reads `<file>` from the git repository"

**What happened:** your agent ran a git command (for example `git show HEAD:.env`) that would print the stored copy of a `.env` or key file.

**Is it safe?** Yes. The command was not run.

**What to do:** if the repository really holds real values in that file, treat them as exposed. Rotate each value (create a new one and stop using the old one), then stop git tracking the file with `git rm --cached <file>` and add it to `.gitignore`. Removing a value from the full history is a bigger job: use a tool such as `git filter-repo`, and rotate anyway.

#### "zn: this command would read a zn secret (the API key or the vault key) from the system keychain, which is protected"

**What happened:** your agent ran a command that asks your system keychain (macOS Keychain, Windows Credential Manager, a Linux secret service) for an entry zn keeps there.

**Is it safe?** Yes. The command was not run. That entry unlocks your vault, so only you should touch it.

**What to do:** nothing, unless you wanted it. To see which secrets zn stores, run `zn secret list` (names only). To change one, use `zn secret set NAME` or `zn secret rm NAME`.

#### "zn blocked this: ~/.zn is where zn keeps your secrets, so agents may not read or change it"

**What happened:** your agent tried to read or change zn's own folder (`~/.zn`), where the encrypted vault and logs live.

**Is it safe?** Yes. Nothing was read or changed.

**What to do:** to use a secret, your agent runs the command with `zn run --secrets NAME -- <command>`, or writes `__ZN_NAME__` in a `secrets_http_request` call. To add a secret, run `zn secret set NAME` in your own terminal.

#### "zn: `<what>` (`<path>`) is protected: an agent may not change how zn and its hooks run" / "zn: this command would change agent hook or plugin settings, which is protected" / "zn: this find deletes files under `<folder>`"

**What happened:** your agent tried to edit the settings that turn zn's hooks on or off, in a place such as `~/.claude`, `~/.codex`, `.cursor` or `.agents`, or ran a command that would, or a `find` that would delete files in zn's folder or an agent's plugins. That would let an agent switch off its own safety checks.

**Is it safe?** Yes. Nothing was changed.

**What to do:** if you want the change, make it yourself in your own terminal or editor. To repair or set up the hooks, run `zn hooks install <agent>`. To remove them, run `zn hooks uninstall <agent>`.

#### "zn: this writes to `<file>`, which your agent reads as standing instructions in later sessions"

**What happened:** your agent wants to write to a file such as `AGENTS.md`, `CLAUDE.md` or `MEMORY.md`. Your agent reads these files at the start of every session, so text written there keeps steering it. zn asks you first. In strict mode (`ZN_STRICT=1`, or `"strict": true` under `hooks` in `~/.zn/config.json`) it blocks instead and says "zn is set to block that".

**Is it safe?** It is safe if you decline. Approve only if you asked for this change.

**What to do:** read what the agent wants to write. Decline if you did not ask for it. To turn the question off, set `"agentInstructionWrites": "off"` under `hooks` in `~/.zn/config.json`, by hand.

### Your agent tried to run a command only you may run

#### "zn blocked this: `<command>` ... is the user's decision"

```text
zn blocked this: `zn-gate init` turns zn's protection on for coding agents, which is the user's decision. Next step: ask the user to run it in their own terminal (`npx -y zn-gate init`).
```

**What happened:** your agent ran a zn command that changes how zn protects you, so zn refused. The message names the command, and the commands are:

- `zn-gate init` and `zn hooks install` or `uninstall`: turn zn's protection on or off for a coding agent.
- `zn-gate pins approve`: approves changed MCP tools.
- `zn unlock` and `zn lock`: unlock or lock the secret vault.
- `zn vault reset`: replaces the vault with an empty one. `zn vault purge`: deletes the vault and its backups for good.
- `zn-gate connect` and `disconnect`: turn the optional cloud check on or off and handle your zn API key.
- `zn stats share on`: turns on sharing of usage statistics.
- `zn secret set`, `get`, `rm`, `reveal`, `import`, `adopt`, `allow`, `approve` and `link`, and `zn env shadow` or `unshadow`: read or change secret values, which never go to the AI model.

**Is it safe?** Yes. The command did not run. An agent must not make these decisions for you.

**What to do:** if you want it, run the command the message gives in your own terminal. If you did not expect it, ask your agent why it tried.

### A command that wipes or damages the machine

#### "zn blocked this: `<reason>`. Ask the user to confirm before running this command."

The reason is one of these, and the rest of the message tells the agent to ask you:

| The message says | What it means |
|---|---|
| "it deletes the home folder, the filesystem root or a system folder, recursively" | A command such as `rm -rf ~` or `rm -rf /`. On by default. |
| "it writes to or formats a disk device" | A command such as `dd` or `mkfs` aimed at a disk. On by default. |
| "it downloads a script and runs it without anyone reading it first" | A download piped into a shell, such as `curl ... \| sh`. Off unless you turn it on. |
| "it changes permissions or owners across the whole filesystem or a system folder" | `chmod -R 777` or `chown -R` on the root or a system folder. Off unless you turn it on. |
| "it is a fork bomb, which freezes the machine" | The classic shell fork bomb. Off unless you turn it on. |
| "it writes downloaded content into a shell startup file, which runs in every new terminal" | A download written into a file such as `~/.bashrc`. Off unless you turn it on. |
| "it has more commands than can be checked, so it is refused rather than guessed at" | A command line too long to check in full. |

**Is it safe?** Yes. The command did not run.

**What to do:** if you meant it, run it yourself in your own terminal. If you did not, tell your agent not to. The rules and how to turn them on or off are in [Destructive commands](destructive-commands.md).

### A secret was used the wrong way in a command

The stored value of a secret goes only into the first command of a command line, and only through zn. These messages mean a command asked for that in a way zn cannot do safely. All are safe: the command did not run, and nothing was sent.

#### "zn: this command has a quote that is not closed, so zn cannot read it"

**What happened:** the command has an opening quote with no closing one, so zn cannot tell where the secret marker sits.

**What to do:** ask the agent to close the quote and send the command again.

#### "zn: this command uses a secret after its first command" / "a secret cannot be used in a command that also has $( ) or backticks"

**What happened:** a `__ZN_NAME__` marker appears later in a chain (after `&&`, `;` or `|`), or in a command that also has `$( )` or backticks, where another command runs inside the command.

**What to do:** ask the agent to run the command that needs the secret on its own, with `zn run --secrets NAME -- <command>`. Do other steps in separate commands.

#### "zn: putting a secret in a shell variable would store only its placeholder" / "a secret in a `VAR=__ZN_NAME__` assignment before a command cannot be filled in"

**What happened:** the command sets a variable to a marker, such as `TOKEN=__ZN_TOKEN__ command`. zn cannot fill markers in there.

**What to do:** use `zn run --secrets NAME -- <command>`. It runs the command with the real value in the environment variable `NAME`, only if you allowed that command for that secret (`zn secret allow NAME --command <command>`).

#### "zn: a secret cannot be used with `<word>`, because it is a shell keyword"

**What happened:** the command starts with a shell word such as `if`, `for`, `while`, `eval` or `sudo`. These are part of the shell language, not programs zn can hand the value to.

**What to do:** ask the agent to run the real program on its own line, through `zn run --secrets NAME -- <command>`.

#### "zn: a secret marker in the arguments of a command is not filled in"

**What happened:** the command has a `__ZN_NAME__` marker in its arguments. zn does not fill it in there, because the value would show in the process list and in command-line logs.

**What to do:** have the agent pass the secret as an environment variable with `zn run --secrets NAME -- <command>`, and have the program read it from there (for example `psql` reads `PGPASSWORD`). For web requests, the agent should use the `secrets_http_request` tool of zn's `secrets` MCP server (zn's own tool that sends the request itself, with the stored value).

#### PowerShell commands that carry a secret

```text
zn: this PowerShell command uses a pipeline, a variable or a script block, so zn cannot safely put a secret into it.
zn: "<name>" is a PowerShell command, not a program, so zn cannot pass a secret to it.
zn: this runs a PowerShell script (.ps1), and zn cannot pass secrets into scripts.
zn: this command does not start with a plain program name, so zn cannot tell which program to run.
```

**What happened:** zn can fill in a secret only when the command starts with a program name. A pipeline, a variable, a built-in PowerShell command (a "cmdlet") or a `.ps1` script is out.

**What to do:** ask the agent to start the command with the program and run it through `zn run --secrets NAME -- <command>`. For web requests, it should use the `secrets_http_request` tool.

#### "zn: this command uses a stored secret. Run it through zn instead"

**What happened:** in Codex, Cursor, Gemini CLI, Antigravity, Copilot CLI and ZCode, zn cannot rewrite a command, so it blocks one that holds a marker and gives the exact command to use (`zn run -- <command>`).

**What to do:** nothing is wrong. Let the agent run the command the way the message says. It works only if you allowed that command for that secret. If it is refused, run `zn secret allow NAME --command <command>` first.

#### "zn: this command contains secret placeholders ... so it needs your approval before it runs" / "zn: restores `<n>` secret value(s) in a git-ignored file"

**What happened:** zn is asking you, not blocking. The command carries `__ZN_NAME__` markers, or it writes a file that git does not track, so zn would put real values into that file on your computer.

**Is it safe?** It is safe to approve when the command is what you expected: the values go only to your own computer, never to the model.

**What to do:** read the command in your agent's approval window. Approve it if you wanted it. Decline if you did not. A file that git tracks keeps markers instead of values on purpose, so put real values in a file that is not tracked, such as `.env.local`. If the message adds that your vault "was started by an older zn-gate version", run `zn lock`, then `zn unlock`. If it says a secret "is blocked by your organization policy", the file keeps the marker: ask your administrator.

#### "zn: a monitor cannot use secret placeholders" / "zn: a WebSocket monitor sends its data to the model without the secret check"

**What happened:** your agent started a monitor (a long-running watcher). A monitor cannot take markers, and one that listens on a live WebSocket connection sends its data to the model without zn's secret check.

**What to do:** have the agent use a monitor that runs a command, because zn checks command output, and `zn run --secrets NAME -- <command>` for any command that needs a secret. A normal monitor gets the message "this monitor's output is checked on this computer before the model sees it": that is zn working, and you only approve it.

#### "zn: WebFetch never receives secret values"

**What happened:** your agent put a marker in the address of a web fetch.

**What to do:** for an authenticated web request, the agent should use the `secrets_http_request` tool of zn's `secrets` MCP server. It sends the request with the real value, only to the hosts allowed for that secret.

### A request would send personal data or a secret away

#### "zn: this command would send `<kind>` to `<host>`. Approve it only if that data should leave this computer." / "zn blocked this command: it would send ..."

**What happened:** a `curl`, `wget`, WebFetch or MCP request holds personal data (an email address, a phone number, a card number) or a literal secret. The message names the kind and the host, never the value. By default zn asks you. If you set the check to `"deny"`, it blocks.

**Is it safe?** It is safe if you decline. If you approve, that data reaches that server.

**What to do:** approve only if that server should get the data. Otherwise decline and ask the agent to send the request without it. Never write the value of a secret in the request. How to change the setting and list trusted hosts: [Network requests that carry personal data](egress-check.md).

#### "zn: this call would send personal data (`<kinds>`) to `<server>`" / "zn: this call would send a secret (`<kinds>`) to `<server>`, so zn blocked it" / "zn: `<server>` never receives secret values"

**What happened:** an MCP call carries personal data (zn asks you), a literal secret, or a `__ZN_NAME__` marker (zn blocks). A stored secret is never passed to another MCP server.

**What to do:** for personal data, approve only if that server should receive it. For a secret, the agent should use the `secrets_http_request` tool for a web request, or remove the value or marker from the call.

#### "zn: `<agent>` asks for secret `<NAME>`. Add it with: zn secret set `<NAME>`"

**What happened:** your agent asked zn for a secret that is not stored yet.

**What to do:** if you want the agent to use it, run `zn secret set NAME` in your own terminal. Otherwise ignore the request.

### A command, patch or output was too big or too complicated to check

zn checks every command and patch before it runs. When one is too large or too deep to check within the time the agent allows, zn blocks it, because letting it through unchecked would be worse. These are safe: nothing ran.

#### "zn: this command is too long for zn to check (over 100 KB)" / "zn: this patch is too long for zn to check" / "zn: this MCP call is too large for zn to check"

**What to do:** ask the agent to split the work into smaller steps. Do not send the same content in pieces to get around the limit. MCP means a tool server your agent talks to; the limit there is 1 MB of arguments.

#### "zn: this command chains more commands than zn checks at once" / "has too many paths for zn to check in time" / "nests shell code deeper than zn checks"

**What to do:** ask the agent to run it as several shorter commands, or to run the inner command directly instead of a shell inside a shell.

#### "zn: this patch was blocked because it writes to `<file>`" / "because it was sent as a shell command"

**What happened:** a patch tried to write a file that holds secrets, or was sent as a shell command (Codex does this with `apply_patch`), which zn cannot check file by file.

**What to do:** for a protected file, make the change yourself. For the second case, ask the agent to use its own `apply_patch` tool, or to write the file another way.

#### "zn: could not read the file names in this patch, so zn cannot check it"

**What happened:** the patch is in a shape zn cannot parse, so it could not tell which files it changes.

**What to do:** ask the agent to send one change per file.

#### "zn: part of this output was withheld because it is too large to check for secrets in time"

**What happened:** a tool printed more than zn can check in time, so zn withheld the part it could not check. In ZCode, which cannot hold output back, the message says so.

**What to do:** ask the agent for a smaller output: a line range, `grep`, `head` or `tail`.

### A secret or odd text showed up in output, a prompt or an answer

#### "zn: `<n>` secret value(s) in this output were replaced with __ZN_ tokens"

**What happened:** the output of a tool contained what looks like a secret. zn replaced each with a token such as `__ZN_AWS_KEY_1__` before the model saw it.

**Is it safe?** Yes. This is zn working. The real values stay on your computer.

**What to do:** nothing, unless the secret was real and is now in a log or a file you share. In that case rotate it. To keep a value usable, run `zn secret adopt <TOKEN>` (for example `zn secret adopt AWS_KEY_1`) in your own terminal. If the message says the vault is locked and markers "cannot be restored", run `zn unlock` in your terminal.

#### "zn: this tool output contained `<kinds>`" (Codex)

**What happened:** an opt-in setting (`replaceToolOutputOnSecret`) makes Codex stop after output that held a real secret.

**What to do:** read the output, rotate the value if it is real, then tell the agent to continue.

#### "zn: this output contains `<n>` secret value(s). ZCode cannot hide tool output"

**What happened:** ZCode cannot replace a tool's output, so zn can only warn. The value is already in the conversation.

**What to do:** rotate the value if it is real, and keep secrets in the zn vault instead of printing them.

#### "zn: this tool output contains text that reads like instructions to you"

**What happened:** the output of a web fetch, an MCP tool or a shell command has text that looks like orders for your agent. zn did not block it. It told the agent to treat the text as data, not to follow it, and to tell you what it asked for. The name of the rule is in brackets.

**What to do:** read what the agent reports. A web page or tool that gave orders to your agent is a reason to stop using that source. To turn this note off, set `"checkToolOutputInstructions": false` under `hooks` in `~/.zn/config.json`. See [compat](compat.md).

#### "zn: this output is mostly invisible characters, so zn removed them and did not pass the original on"

**What happened:** a tool's output was almost all invisible characters, which can hide text from you while a model still reads it. zn replaced it.

**What to do:** do not ask the agent to read it again. Find where the output came from.

#### "zn: this command was not run because its expanded text contains a secret value" / "is too long to check" / "would put a private key in front of the model"

**What happened:** you typed a skill or command whose full text, after files it includes are added, holds a secret value or a private key, or is too long to check.

**What to do:** remove the value from the skill, the command or the file it includes. Save it with `zn secret set NAME` and refer to it as `__ZN_NAME__`. For the too-long case, use a shorter skill or point it at a file the agent reads.

#### "zn: this prompt was not sent because it contains a secret"

**What happened:** the prompt you typed holds a secret value, so zn did not send it to the model.

**What to do:** save the value with `zn secret set NAME`, then write `__ZN_NAME__` in your prompt where the value goes.

#### "zn: your last answer contains `<a secret value>`" / "zn: the last answer contains ..."

**What happened:** after an answer, zn found a secret value, or a `__ZN_` marker it never saw earlier in this session (a possible invention), in the answer.

**Is it safe?** By default zn only warns you. With the setting below it asks the agent to rewrite the answer once.

**What to do:** do not share the answer before you have checked it, and rotate the value if it is real. To have zn ask the agent to rewrite such answers, add this to `~/.zn/config.json` by hand. There is no command for it yet, and zn does not change that file for you:

```json
{"hooks": {"stopReview": "block"}}
```

If the file already has other settings, add the `hooks` entry beside them. More in [compat](compat.md).

#### "zn: could not check the last answer for secrets"

**What happened:** zn tried to review the last answer and something failed inside zn, so the answer was not checked. zn does not block here, because that could trap the agent.

**What to do:** check the answer yourself before sharing it. Run `zn-gate status` to see whether zn is healthy, and `zn hooks install <agent>` to set the hooks up again. If it repeats, ask in [Discussions](https://github.com/usezn/zn/discussions).

### zn could not read what your agent asked for, or could not run

#### "zn: part of zn-gate is missing from this installation" / "zn: something went wrong inside the zn hook"

```text
zn: part of zn-gate is missing from this installation, so zn cannot check this action and blocked it. Ask the user to reinstall it with `npm install -g zn-gate@<version>` and then run `zn hooks install`.
zn: something went wrong inside the zn hook, so this action was blocked to keep the user's secrets safe. If it happens again, ask the user to run `zn hooks install <agent>` to set up zn for <agent> again.
```

**What happened:** the hook that checks your agent could not run its checks, because part of zn-gate is gone (often after a Node.js upgrade) or something broke inside it. zn blocks what it cannot check. Related messages say the hook "cannot start because the Node.js or the zn-gate files it was installed with are gone", "failed", "ended without confirming its answer", or that "the check could not finish in time or failed" (Antigravity).

**Is it safe?** Yes, the action was blocked. But nothing is being checked until you repair it.

**What to do:** run `npm install -g zn-gate`, then `zn hooks install <agent>`, then `npx -y zn-gate check`. If you use the Claude Code plugin, run `claude plugin update zn-gate@usezn` instead. The [check page](check.md#the-hooks-are-set-up-but-cannot-run) explains each case, and [compat](compat.md#if-your-agent-blocks-every-prompt) covers an agent that blocks every prompt.

#### "zn: could not check this action against your secret vault, so it was blocked"

**What happened:** the check needs your vault and the vault was not running or could not be used.

**What to do:** run `zn unlock` in your own terminal and try again. See [section 5](#5-your-secret-vault-is-locked).

#### "zn: could not read this action (`<why>`), so it was blocked" / "could not read the tool name of this call" / "could not read the command of this call"

**What happened:** the event your agent sent to zn was damaged or in a shape zn does not know, so zn could not check it.

**What to do:** retry the action. If it repeats, run `zn hooks install <agent>` again, then `npx -y zn-gate check`.

#### "zn: this action names a file or text that is not valid Unicode text, so it was blocked"

**What happened:** a file name or text in the request has broken characters (a damaged text encoding), so zn cannot read it safely.

**What to do:** check the file names in the request and rename a file with strange characters.

#### "zn: could not read a file address in this call" / "could not read the file this call uses" (Gemini CLI, Antigravity, Cursor, ZCode, Copilot CLI)

**What happened:** the agent sent a call that zn could not tell which file or command it names, so it blocked it.

**What to do:** ask the agent to name the file explicitly in the request, with a plain path. If it keeps happening, run `zn hooks install <agent>` again.

#### "zn: the secret scrubber is not working (`<why>`)" (OpenCode)

**What happened:** OpenCode's zn plugin could not run its secret check, so the call was blocked, the message was not sent, or the output was withheld. The "scrubber" is the part that swaps secret values for markers.

**What to do:** run `zn-gate status`, then `zn hooks install opencode`, then start OpenCode again.

#### "... `<agent>` cannot show that question, so zn blocked the action instead"

**What happened:** zn wanted to ask you, but this agent (Codex, Cursor for some hooks, OpenCode, Gemini CLI) cannot show a question, so zn blocked the action and told the agent what and why.

**What to do:** if the action is fine, make the change yourself outside the agent, or ask the agent to try again after you change what zn objected to. The question types are in [compat](compat.md).

#### "zn: A command different from the one zn checked was run" (Codex)

**What happened:** Codex runs all hooks at once, so another tool's hook can change a command after zn checked it. zn found out afterwards and withheld the output.

**What to do:** review the other hooks set up for Codex and remove any you do not need. See [Another hook runs next to zn's](check.md#the-codex-hook-is-set-up-wrongly) and [compat](compat.md).

#### "zn: your team policy would block `<name>` here"

**What happened:** your organization's zn Team policy would block this, but this computer only records it. It was allowed.

**What to do:** nothing is broken. If you think the action should be allowed, ask your administrator. See [team](team.md).

### Messages about other tools (MCP servers and shield)

MCP servers are tool servers your agent talks to. zn-shield sits between your agent and such a server and checks what passes. See [shield](shield.md).

#### "[zn-shield TOOLS CHANGED]" / "[zn-shield TOOLS REFUSED]"

**What happened:** an MCP server now lists tools that are new or different since you approved them, or lists two tools with the same name, or tools without a valid name. Changed tools are a way a trusted server can turn bad, so zn asks you first.

**What to do:** read the list of changed tools. If you trust the change, run `zn-gate pins approve <server>` (or `zn-gate pins approve --all`) in your own terminal. For "refused", you cannot approve it: the server has to fix its tool list. More in [shield](shield.md).

#### "[zn-shield BLOCKED REQUEST]" / "BLOCKED TOOL DESCRIPTION" / "BLOCKED PARAMETER DESCRIPTION" / "BLOCKED TOOL" / "BLOCKED TOOL NAME" / "BLOCKED SERVER MESSAGE" / "BLOCKED RESPONSE"

**What happened:** zn-shield found text that looks like a prompt injection (text that tries to give your agent new orders) in a call your agent sent, in a tool's description, name or parameter, or in a reply from the tool. Some of these say instead that a message was too large, too deep or not valid JSON, so it could not be checked. The name after "Rule:" says which kind of text it was. See [the rules table](#what-a-rule-name-means) below.

**Is it safe?** Yes. The call or reply was blocked before the agent used it.

**What to do:** do not retry with reworded text. Find where the text came from: a tool description from an MCP server you do not trust is a reason to remove that server. If you are sure it is a false alarm, report it at [Discussions](https://github.com/usezn/zn/discussions) without any secret.

#### "[REDACTED BY ZN-GATE: Malicious prompt injection payload detected ...]"

**What happened:** zn-gate removed part of a tool's output because it looked like an attempt to give your agent new orders. The text in brackets replaces it.

**What to do:** treat the source of that output with care. Do not ask the agent to bring the text back.

#### "Plaintext credential in an MCP server configuration (`<kind>`)"

**What happened:** `zn-gate audit` or `zn-gate scan` found a password, token or key written in plain text in an agent's MCP settings file.

**What to do:** keep the real value out of that file. For a header or URL value, use an environment variable your agent supports and keep the real value in your own shell settings. For other values, `zn secret set NAME`, then put `__ZN_NAME__` in the file. Rotate the value if the file was ever committed or shared.

### A rule blocked text that looked like an attack

#### "zn-gate blocked `<target>`. Reason: `<description>` (rule: `<id>`)"

**What happened:** one of zn-gate's built-in rules matched text that was about to reach your agent or a tool. This is the main message of the guard library (Node.js and Python). In the Python package the message also says first whether the call ran: "The call did not run, so nothing was sent or changed" or "The output of this tool was withheld".

**Is it safe?** Yes. The text was blocked before use.

**What to do:** do not retry with reworded text. Tell the person who runs the agent, and find where the text came from. If the target ends in `:result` or `:tool_output`, do not use the result and ask where the data came from. The rule name tells you which kind of text it was: see the table below. Rules are fixed in the product. You can add your own with `.znrules` or `zn.config.json` (see the [README](../README.md)), but you cannot switch a built-in rule off.

#### What a rule name means

| Rule name starts with | What it caught, in plain words |
|---|---|
| `pi:ignore_previous`, `pi:disregard`, `pi:forget`, `pi:new_instructions` | Text that tells the agent to ignore or replace its earlier instructions. |
| `pi:identity_override`, `pi:act_as`, `pi:pretend`, `pi:roleplay` | Text that tells the agent it is now someone else or should play a different role. |
| `pi:system_tag`, `pi:system_bracket`, `pi:template_boundary` | Text that pretends to be a system message, or copies the hidden markers a chat model uses to separate system and user messages. |
| `pi:jailbreak`, `pi:bypass`, `pi:override` | Text that tries to switch off the agent's safety rules. |
| `pi:identity_request`, `pi:identity_request_multi` | Text that tells the agent to look up who you are (your user name or git email) and put it somewhere. |
| `pi:multi_es`, `pi:multi_pt`, `pi:multi_fr`, `pi:multi_de`, `pi:multi_ru`, `pi:multi_zh` | The same kind of "ignore your instructions" order, written in Spanish, Portuguese, French, German, Russian or Chinese. |
| `indirect:html_comment`, `indirect:hidden_tag` | Instructions hidden in a web page comment or an invisible element. |
| `evasion:bidi_override` | Invisible text-direction characters that can make text look different from what a program reads (the "Trojan Source" trick). |
| `evasion:base64_smuggling` | A command that decodes hidden Base64 text and runs it. |
| `exfil:markdown_image` | An image link that carries data in its web address, which can leak information when the image loads. |
| `exfil:credentials` | Text that asks to read or send passwords or keys. |
| `path:sensitive_file` | Text that points at a file that usually holds passwords or keys, such as `.env` or `~/.ssh`. |
| `secret:...` | A secret value, such as a cloud key, a token, a private key or a password in a web address, in the text. |
| `custom:banned_pattern`, `custom:forbidden_path` | A rule you or your team added in `.znrules` or `zn.config.json`. See the next entry. |
| `size:truncated`, `size:oversize`, `size:nesting`, `size:invisible` | The text was too big, too deeply nested, or mostly invisible characters. See below. |

#### "Matches custom repository rule" / "Matches custom repository forbidden path"

**What happened:** a rule in this project's own `.znrules` or `zn.config.json` matched. It is not one of zn's built-in rules.

**What to do:** open that file at the root of your project and look at the pattern or path in the message. Change or remove the rule if it is wrong. If a teammate added it, ask them.

#### "Output too large to scan in full" / "Input too large to scan in full" / "nested too deeply to check"

**What happened:** zn-gate scans text in windows up to a limit (4 MB for a tool result). Text past it, or nested too deeply to walk, is blocked, because the part that was not scanned could hold an attack.

**What to do:** ask for a smaller output or split the input. If you trust the tool and want large results to pass without a full check, set `ZN_ALLOW_TRUNCATED=1` (or `allowTruncated` in your code). See [api-reference](api-reference.md).

### Messages from commands you run yourself

#### "Exposed credential detected by DLP filter"

**What happened:** `zn-gate scan` (or `audit`) found something that looks like a real secret stored in plain text in a file. "DLP" stands for data loss prevention: a filter that spots secrets. The finding shows a masked sample, never the value, and ends with a "Next:" line.

**What to do:** follow that line. For a `.env` file it is `npx -y zn-gate env shadow <file>`. For other files it is `npx -y zn-gate secret set NAME` and a `__ZN_NAME__` marker in the file's place. For a private key, move it out of the file. Rotate any value that was ever committed or shared.

#### "Unknown command" / "unknown argument" / "Target path does not exist" / "--format for scan must be text, json or github" / "Please provide text to analyze"

**What happened:** zn-gate did not understand what you typed, such as a typo, a missing folder or a missing text.

**What to do:** run `zn-gate --help` to see the commands. Examples: `zn-gate scan .`, `zn-gate scan . --format json`, `zn-gate analyze "some text"`.

#### "[zn-gate] Fatal error"

**What happened:** zn-gate stopped because of a problem it did not expect. The text after it says what.

**Is it safe?** Nothing was changed by that failure.

**What to do:** run the command again, then `zn-gate status`. If it repeats, report it at [GitHub issues](https://github.com/usezn/zn/issues) with the message and your `zn-gate --version`, and leave out any secret.

#### "Tamper detected"

**What happened:** `zn-gate evidence --verify` found that the evidence log was changed or damaged, so its chain of records no longer matches. The message gives the place of the break and a command to move the file aside.

**Is it safe?** Your protection keeps working. Only the record is in doubt.

**What to do:** the steps are the same as for ["the evidence log ... is damaged"](#10-the-evidence-log--is-damaged): keep the old file for review, move it aside with the command printed, and the next event starts a new log.

#### "Not allowed: `<detail>`" / "Not found: `<detail>`"

**What happened:** zn refused a request, or could not find what you named. The detail says what. "Not allowed" usually means a rule or a team policy, or a step that only a person at a terminal may do.

**What to do:** read the detail. If it names a command to run, run it in your own terminal. If it names a team policy, ask your administrator. Otherwise run `zn-gate status`, and ask in [Discussions](https://github.com/usezn/zn/discussions) if you are stuck.

#### "zn could not use your secret vault: `<error>`"

**What happened:** the vault is not locked, but something stopped zn from using it, such as a damaged file or a refusing keychain.

**What to do:** see "If the passphrase is right but the vault will not open" in [section 5](#5-your-secret-vault-is-locked). Do not run `zn vault reset` first.

#### "the Copilot hooks file had `disableAllHooks` turned on and zn removed it" / "your Copilot user settings have `disableAllHooks` turned on"

```text
"disableAllHooks" was true in this file and was removed: it switched every hook of the file off.
your Copilot user settings have "disableAllHooks" turned on; the docs do not say whether that skips hook files, so check that zn still runs
```

**What happened:** the first line comes from `zn hooks install copilot`: zn's own Copilot hooks file had `"disableAllHooks": true`, which makes Copilot CLI skip every hook in the file, so the install removed it. The second line comes from `zn-gate check`, under an OK line: your own Copilot settings set it, and GitHub's documentation does not say whether that also skips hook files.

**Is it safe?** The first line means protection is back on. For the second, check that zn still runs.

**What to do:** for the first, nothing. For the second, remove the setting if you did not set it on purpose, then run `npx -y zn-gate check` again. The [check page](check.md#copilot-cli-settings-switch-the-hooks-off) explains the other Copilot lines.

### Where a message points you

- A message that ends with "More: <https://usezn.com/docs/zn-gate/troubleshooting/>" (a vault that did not start, a damaged vault file, a failed audit log check) points to this page. [Section 5](#5-your-secret-vault-is-locked) covers the vault, and [section 10](#10-the-evidence-log--is-damaged) the logs.
- A message that ends with "Docs: docs/audit.md" means the [audit page](audit.md): [`docs/audit.md`](https://github.com/usezn/zn/blob/main/docs/audit.md) on GitHub.

## Also useful

- Your agent blocks every prompt after you upgraded or removed Node.js: see [If your agent blocks every prompt](compat.md#if-your-agent-blocks-every-prompt).
- Not sure what is protected: `npx -y zn-gate check`, explained in [check](check.md).
- Still stuck: ask in [Discussions](https://github.com/usezn/zn/discussions). Say your zn-gate version (`zn-gate --version`), your operating system and the message, and leave out any secret.

### TLS certificates and trust stores

When zn-gate talks to usezn.com (only if you turned on the cloud check: `zn-gate connect` for the Node.js package, `ZN_API_KEY` with `ZN_CLOUD=1` for the Python package), it checks that the website's certificate was issued by a certificate authority your computer trusts. zn-gate does not carry a list of authorities of its own. It uses the list that comes with your tools:

- **The Node.js package** uses the list built into your copy of Node.js.
- **The Python package** uses the list of your operating system (on macOS, the list of your Python installation), through Python's standard library. It needs no extra packages.

From time to time browsers and runtimes stop trusting a certificate authority. If that authority issued the certificate of a site you use, the connection fails with a message such as "unable to verify the first certificate" or "certificate verify failed" until your list is updated. Your local checks keep working in the meantime. Nothing about this is specific to zn-gate, and the fix is to update the tools that hold the list:

1. **Update Node.js** to the latest release of the line you use (see `node --version`), from [nodejs.org](https://nodejs.org/) or with your version manager (for example `nvm install 22`). Recent Node.js releases carry an up-to-date list, and a release you installed long ago does not. Open a new terminal afterwards.
2. **Update your operating system's list.** On Debian or Ubuntu: `sudo apt-get update && sudo apt-get install --only-upgrade ca-certificates`. On macOS and Windows, install the pending system updates; the list is part of them. With Python from python.org on macOS, run Install Certificates.command again from the Python folder in Applications; with Homebrew, `brew upgrade ca-certificates`.
3. Run your command again.

The Node.js package always refuses a connection whose certificate does not check out, even when `NODE_TLS_REJECT_UNAUTHORIZED=0` is set. If `NODE_EXTRA_CA_CERTS` or `SSL_CERT_FILE` is set in your terminal, it will not send the key saved by `zn-gate connect` (see [8. "will not send the saved key"](#8-will-not-send-the-saved-key-tls-settings)). A key you pass in `ZN_API_KEY` (or with `--key`) is sent anyway, and Node.js then trusts `NODE_EXTRA_CA_CERTS`. The Python package follows your system's TLS settings, `SSL_CERT_FILE` and `SSL_CERT_DIR` included. In every case, updating the list as above is the better fix.

### Hooks block everything: "zn-gate changed since the hooks were installed"

The hook launcher keeps a fingerprint of zn-gate's hook runner and runs it only while it matches, so after the files change your agent blocks its tool calls and prompts and shows the message "zn-gate changed since the hooks were installed". `npm update -g zn-gate` fixes the launchers by itself, but not when the update ran with `--ignore-scripts`, with bun, or with `sudo`. In your own terminal, without `sudo`, run `zn hooks install <agent>` again (for example `zn hooks install claude-code`), then start a new session. More in [check](check.md) and [upgrading](upgrading.md).

### npm says EACCES when init installs zn-gate

On macOS (Node.js from nodejs.org) and on Linux (Node.js from your distribution), npm often cannot write to its global folder, so `npm install -g zn-gate` fails with `EACCES`. `zn-gate init` says so and lists the agents left unprotected until zn-gate is installed. Do not use `sudo`. Give npm a folder in your home directory, in your own terminal:

```sh
mkdir -p ~/.npm-global && npm config set prefix ~/.npm-global
echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.zshrc
```

Use `~/.bashrc` instead of `~/.zshrc` if you use bash. Then open a new terminal and run `npx -y zn-gate init` again. A Node.js version manager such as nvm also avoids the problem. This does not apply to Windows.

**To see the technical detail of an error:** run the command again with `ZN_VERBOSE=1`, or set `DEBUG=zn` (also `zn*`, `zn:*`, `zn-gate` or `zn-gate:*`, alone or in a comma-separated list). Other `DEBUG` values, such as `DEBUG=*`, do not change what zn prints. The Node.js and Python packages follow the same rule.
