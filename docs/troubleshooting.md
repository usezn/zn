# Troubleshooting

The ten messages people most often meet when they first use zn-gate: what each one means and what to do. Each message is copied as zn-gate prints it. A part in angle brackets, such as `<agent>`, is a blank that zn fills in for you.

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
zn hooks: Not allowed: zn hooks install needs an interactive terminal.
zn env: Not allowed: zn env shadow needs an interactive terminal.
zn-gate connect needs an interactive terminal.
<command> must be run by you in your own terminal, not by an AI agent (detected CLAUDECODE).
An AI agent is running this, so zn only prints the steps: installing hooks is your decision. Nothing was changed.
```

**What it means:** some steps change your settings or touch your secrets, so zn only runs them when a person types them. It refuses when your AI agent runs them, or when a script runs them with nobody at the keyboard. This is on purpose. Nothing was changed.

**What to do:** open a terminal window yourself (not the agent's window) and run the same command there. If you only see "started from ...", zn thinks an agent is above your terminal in the process chain. Open a fresh terminal window from your system menu and try again. For `init`, the steps printed under the message are the commands to run.

## 5. "Your secret vault is locked"

```text
Your secret vault is locked. Unlock it in this terminal with: zn unlock. Then run this command again.
```

**What it means:** zn keeps the real values of your secrets in an encrypted vault, and the vault is closed. It closes by itself after a few hours or when you restart your computer. If `zn` is not installed on your computer, the message gives the `npx -y zn-gate@<version> unlock` form instead.

**What to do:**

1. Run `zn unlock` in your own terminal. It may ask for a passphrase. Type it yourself: zn never reads it from your agent.
2. Run `zn vault status` to see that it says unlocked.
3. Run the command that failed again.

More in [secrets](secrets.md). If it asks for a terminal to enter the passphrase and you have none (for example over SSH), see "If something fails" there.

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

```text
That does not look like a zn API key (they start with zn_). Nothing was saved.
usezn.com did not accept this key (it may be revoked or mistyped). Nothing was saved.
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
NODE_TLS_REJECT_UNAUTHORIZED=0 is set, so zn-gate will not send the saved key over a connection whose certificate is not checked
```

**What it means:** your terminal has a setting that turns off the check of website certificates, or that changes how secure connections work. zn-gate refuses to send your saved key through such a connection. Similar messages name `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `OPENSSL_CONF`, `NODE_DEBUG` or `NODE_OPTIONS` instead. Your local checks keep working.

**What to do:** remove the setting named in the message, open a new terminal and try again. On macOS or Linux, `unset NODE_TLS_REJECT_UNAUTHORIZED` removes it for this terminal. Look in your shell startup file (such as `~/.zshrc` or `~/.bashrc`) if it comes back. If a company proxy needs its own certificate, ask your administrator. Do not turn off certificate checks.

## 9. Your agent ignores zn's hooks on a managed computer

```text
Your organization's Claude Code policy (<file>) turns off all hooks (disableAllHooks), so zn's hooks do not run. Claude Code does not show this. Ask your administrator to add zn to the managed settings.
```

Other versions say that the policy "runs only the hooks in its managed settings (allowManagedHooksOnly)", that a settings file of yours "sets disableAllHooks", or that a managed MCP list does not include zn's "secrets" server.

**What it means:** your company or school controls Claude Code's settings and they stop zn's hooks from running. Claude Code itself shows no warning, so zn tells you when you install hooks or run `zn-gate status`. Until this is fixed, zn is not protecting that agent.

**What to do:**

- If the message names your own settings file, remove the `disableAllHooks` line and run `zn-gate check`.
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

## Also useful

- Your agent blocks every prompt after you upgraded or removed Node.js: see [If your agent blocks every prompt](compat.md#if-your-agent-blocks-every-prompt).
- Not sure what is protected: `npx -y zn-gate check`, explained in [check](check.md).
- Still stuck: ask in [Discussions](https://github.com/usezn/zn/discussions). Say your zn-gate version (`zn-gate --version`), your operating system and the message, and leave out any secret.
