# Example: unlock the vault on a server without a keychain

A server, a container or an SSH session usually has no desktop keychain. zn then keeps the vault key behind a passphrase, and a person types that passphrase in a terminal. This example shows the steps, with made-up values. Run every command yourself in a terminal. An AI agent cannot unlock the vault: `zn-gate unlock` refuses to run under an agent.

For the full picture, read [Keep secrets out of your coding agent](../secrets.md) and the [`unlock` reference](../cli.md#unlock).

## 1. Check which backend zn uses

Undo: nothing to undo.

```bash
npx -y zn-gate vault status
```

On macOS zn uses the Keychain, and on Windows the Credential Manager. On Linux it uses the Secret Service only when a desktop session bus is running and the `secret-tool` program is installed. Otherwise, which is the usual case on a server, it uses a passphrase. If the vault already exists, `vault status` prints the backend it was created with, locked or not.

## 2. Create the vault with a passphrase (first time only)

Undo: `npx -y zn-gate vault reset` sets the vault aside and starts empty, but the values stored in it are lost.

```bash
npx -y zn-gate unlock --backend passphrase --foreground
```

zn asks for a new passphrase twice, with the typing hidden. It must be at least 12 characters. Keep it in a password manager: without it nobody can open the vault again.

## 3. Keep the unlocked vault in a terminal of its own

Use a terminal multiplexer such as `tmux`, so the terminal keeps running after you disconnect from the server:

```bash
tmux new -s zn-vault
npx -y zn-gate unlock --foreground
```

`--foreground` keeps the vault in this terminal. zn then asks here, and only here, before a command uses a secret for the first time or before a policy changes. Keep the terminal open while you work. The vault stays unlocked for 8 hours, or until 30 minutes without use, whichever comes first.

Without `--foreground`, `unlock` still works, but it prints that no dialog is available and that first-use approvals and policy changes are refused. Use `--foreground` when you need to approve something.

If the vault is already unlocked, `unlock` stops with "already unlocked". Run `npx -y zn-gate lock` first.

## 4. Lock it when you are done

```bash
npx -y zn-gate lock
```

Or press Ctrl+C in the terminal from step 3.

## Scripts and pipes

`--passphrase-stdin` reads the passphrase from standard input, and it is the only way to unlock without a terminal. zn never reads the passphrase from a command-line argument or an environment variable.

The option moves the risk to whatever feeds the pipe. If that is a file, the file holds the key to the vault. Do not store the passphrase in a file in a repository, in a CI variable, or anywhere an agent can read, and keep it out of your shell history. Do not use this option in a CI job: a CI job should only run the read-only checks, such as `zn-gate scan` and `zn-gate audit`.

## What to check when it does not work

- "needs an interactive terminal": run the command in a terminal window. The only option that works without one is `--passphrase-stdin`, and it does not combine with `--foreground`.
- "Cancelled: no passphrase was entered": nothing was changed. Run the command again.
- "The two passphrases do not match": nothing was created. Run the command again and type the same passphrase twice.

More messages are in [troubleshooting, section 5](../troubleshooting.md#5-your-secret-vault-is-locked).

---
