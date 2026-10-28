# Troubleshooting

The eleven messages people most often meet when they first use zn-gate: what each one means and what to do. Each message is copied as zn-gate prints it. A part in angle brackets, such as `<agent>`, is a blank that zn fills in for you.

Run every command in your own terminal, not through your AI agent. New here? Start with [First 5 minutes](first-5-minutes.md). Words you do not know are in the [glossary](glossary.md).

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

## 12. Short messages

These are one-line messages zn prints when it stops on purpose. Each says what to do next; this table adds the reason.

| Message starts with | What it means |
|---|---|
| `invalid join token (expected znj_...)` | The text you pasted is not a join token. Copy it again from the invitation your administrator sent. |
| `nothing to approve: this machine has no organization policy waiting for your answer` | There is no pending question from your organization. Run `zn team status` to check. |
| `The two passphrases do not match` | You typed the passphrase twice and the two differed. Nothing was created; run `zn unlock` again. |
| `The vault is already unlocked, so there is nothing to do` | The vault is open. To unlock it again (for example with a new time limit), run `zn lock` first. |
| `The --ttl and --idle times must be between 1m and 24h` | Use a time such as `30m` or `8h`. |
| `Cancelled: nothing was entered` | You closed the prompt without typing a value. Run the command again when you are ready. |

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

### npm says EACCES when init installs zn-gate

On macOS (Node.js from nodejs.org) and on Linux (Node.js from your distribution), npm often cannot write to its global folder, so `npm install -g zn-gate` fails with `EACCES`. `zn-gate init` says so and lists the agents left unprotected until zn-gate is installed. Do not use `sudo`. Give npm a folder in your home directory, in your own terminal:

```sh
mkdir -p ~/.npm-global && npm config set prefix ~/.npm-global
echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.zshrc
```

Use `~/.bashrc` instead of `~/.zshrc` if you use bash. Then open a new terminal and run `npx -y zn-gate init` again. A Node.js version manager such as nvm also avoids the problem. This does not apply to Windows.

**To see the technical detail of an error:** run the command again with `ZN_VERBOSE=1`, or set `DEBUG=zn` (also `zn*`, `zn:*`, `zn-gate` or `zn-gate:*`, alone or in a comma-separated list). Other `DEBUG` values, such as `DEBUG=*`, do not change what zn prints. The Node.js and Python packages follow the same rule.
