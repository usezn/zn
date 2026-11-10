# Example: unlock the vault from a script with --passphrase-stdin

`zn unlock` normally asks for the vault passphrase at a hidden prompt. `--passphrase-stdin` reads it from standard input instead, so a script can pass it through a pipe. This page shows a script that a person runs in their own terminal. It types the passphrase once, passes it through the pipe, and keeps no copy of it. All names are made up.

The option has limits, and most of them are there on purpose. Read them before you write a script.

## When the option works

- Only for a vault that uses the **passphrase** backend, that is, one with no system keychain. With the keychain, `zn unlock` unlocks without asking anything, and it needs an interactive terminal. A script on a pipe gets this message: `zn unlock needs an interactive terminal: run it in your own terminal window`. The keychain check is in `packages/zn-gate/lib/vault/cli.js` (around line 276). `docs/cli.md` describes the option the same way: it "reads the passphrase from a pipe when there is no system keychain".
- Never when an AI agent runs it. `zn unlock` checks for an agent first and refuses with: `zn unlock must be run by you in your own terminal, not by an AI agent` (`packages/zn-gate/lib/vault/cli.js`, around line 266).
- The passphrase is read from stdin only. zn does not take it from an argument or from an environment variable (`packages/zn-gate/lib/vault/cli.js`, line 18). zn reads all of stdin until it ends, and removes one trailing line break (`readStdin`, lines 163 to 168).

## The script

Save it in a folder of your own, not in a project and not in a repository. Run it in your own terminal:

```bash
#!/usr/bin/env bash
# Unlock the zn vault for one hour. Run in your own terminal; it asks for the passphrase.
set -eu

# Typed at a hidden prompt, held in a shell variable only, never written to a file.
IFS= read -rs -p "Vault passphrase: " PASS
echo

printf '%s\n' "$PASS" | zn unlock --ttl 1h --passphrase-stdin
unset PASS

zn vault status
```

What each part does:

- `read -rs` reads a line without echoing it. It works only in a terminal, so the script must run in one.
- `printf '%s\n' "$PASS"` is a shell builtin, so the passphrase is not in the list of processes. It goes into the pipe, and `zn unlock` reads it from there.
- `unset PASS` removes the variable when the script is done with it. The shell also ends it when the script exits.
- `zn vault status` shows whether the vault is unlocked.

## What not to do

- Do not put the passphrase in the script, in a file, in an environment variable or in a command argument. Any of these keeps a copy that a program or a person can read later, which is what the vault is meant to prevent.
- Do not store the passphrase in a secrets file of the project, or in a CI setting, to make a script run without you. The vault is encrypted with that passphrase, so a copy next to it removes most of the protection.
- Do not run the script through an agent. The agent cannot unlock the vault for you, and `zn unlock` refuses when it detects one.

## If it does not work

| You see | What it means | What to do |
| --- | --- | --- |
| `needs an interactive terminal` | The vault uses the keychain, or the script runs without a terminal | Run the script in a terminal window. A keychain vault is unlocked without a passphrase |
| `must be run by you in your own terminal, not by an AI agent` | An agent started the command | Run the script yourself |

Lock the vault again when you are done, with `zn lock`. It also locks when the time set with `--ttl` ends, or after the `--idle` time without use ([cli.md, unlock](../cli.md#unlock)).

## Related

- [Command line reference: unlock](../cli.md#unlock): every option and exit code.
- [Secrets: the vault](../secrets.md): how the vault and its backends work.
