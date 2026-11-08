# Example: unlock the vault for a set time, let it expire, then lock it

A short walk-through of how long the zn vault stays open. `unlock` opens it for one session, `--ttl` sets the longest that session can last, and `lock` closes it at once. When the time is up the vault locks itself. Everything here is documented in the [command reference](../cli.md) and in [Secrets](../secrets.md). All values and times in this page are made up or from a throwaway test.

Run the commands yourself, in your own terminal. When an AI agent runs `unlock`, it refuses and changes nothing.

The commands are shown as `zn ...`. If `zn` is not on your `PATH`, the messages show `npx -y zn-gate@<version> ...` in its place; type whichever works for you. The output below was captured on a computer with no system keychain, so the vault uses a passphrase. With a keychain, `unlock` asks nothing and creates no passphrase.

## 1. Know the limits

Two timers apply to an unlocked vault:

- `--ttl` is the session length: the vault locks after this long, whatever the use. The default is 8 hours. It takes a number with `s`, `m` or `h`, between 1 minute and 24 hours.
- `--idle` locks the vault earlier when nothing has used it for this long. The default is 30 minutes, with the same units and range.

A value outside the range is refused before anything is asked, and nothing is done:

```bash
zn unlock --ttl 30s
```

```text
[zn] The --ttl and --idle times must be between 1m and 24h, for example 8h.
[exit 2]
```

(`[exit N]` is added here to show the exit code. It is not part of the output.)

## 2. Unlock for one minute

One minute is the shortest session. It is used here so the expiry in step 4 does not take long. In daily use you will normally keep the 8 hours default and run only `zn unlock`.

```bash
zn unlock --ttl 1m
```

On a computer with no keychain, it asks for the passphrase at a hidden prompt. The first time it also asks you to repeat it, because it is creating the vault. For a script, add `--passphrase-stdin` and pipe the passphrase in. This is the output:

```text
Created a new vault (passphrase) in ~/.zn/vault
Vault unlocked: locks after 30 min idle, or at 12:17 (in 1 min) at the latest. Run `zn lock` to lock now.
Note: no system dialog is available here, so first-use approvals and policy changes will be refused.
      To approve them, run the vault in a terminal of its own instead: zn lock && zn unlock --foreground
[exit 0]
```

The message names both limits: the idle time, and the clock time of the end of the session, in your local time, with the time left. Whichever comes first locks the vault. The last two lines appear only when there is no system dialog; see [Secrets](../secrets.md) for what they mean.

While the vault is open, `zn vault status` shows the same information and `zn secret list` works (this vault is new, so it is empty):

```bash
zn vault status
zn secret list
```

```text
Vault: unlocked (backend passphrase, locks after 30 min idle, or at 12:17 (in 1 min) at the latest, zn-gate 1.15.0)
Location: ~/.zn/vault
[exit 0]
No secrets stored. Add one with: zn secret set NAME   or import a .env: zn env shadow .env
[exit 0]
```

Running `unlock` again on an open vault changes nothing. It does not extend the session:

```bash
zn unlock --ttl 1m
```

```text
[zn] The vault is already unlocked, so there is nothing to do. To unlock it again, run `zn lock` in your own terminal first.
[exit 1]
```

## 3. Lock it yourself

When you are done, lock the vault without waiting for the timer:

```bash
zn lock
zn vault status
zn lock
```

```text
Vault locked.
[exit 0]
Vault: locked (backend passphrase)
Location: ~/.zn/vault
[exit 0]
Vault was not unlocked.
[exit 0]
```

`lock` takes no options. Running it when the vault is already locked is not an error: it says so and exits `0`. Locking does not delete anything. The secrets stay in the vault, encrypted, and the next `unlock` opens it again.

## 4. Let the session expire

Unlock again with the same one minute session and wait for the end time that `unlock` printed. This capture was taken 75 seconds after the unlock:

```bash
zn unlock --ttl 1m
sleep 75
zn vault status
zn secret list
```

```text
Vault unlocked: locks after 30 min idle, or at 12:17 (in 1 min) at the latest. Run `zn lock` to lock now.
...
Vault: locked (backend passphrase)
Location: ~/.zn/vault
[exit 0]
zn secret: Your secret vault is locked. Unlock it in this terminal with: zn unlock. Then run this command again.
[exit 1]
```

The vault locked by itself at the end time, with no command from you. A command that needs a secret now fails with a plain message and exit `1`; it does not hang and does not ask for a passphrase by itself. Run `zn unlock` in your own terminal, then run the command again. The first `unlock` line is trimmed to its first line here; the note lines after it are the same as in step 2.

## What to check

- `zn vault status` says `unlocked` or `locked`, and when an unlocked vault will lock.
- The time in `unlock` and `vault status` is your local time, and the part in brackets is the time left.
- The session ends at the `--ttl` time even if you keep using the vault. Only the idle timer is reset by use.
- A session cannot be longer than 24 hours. To keep working after it ends, run `unlock` again.
- An agent cannot unlock the vault for you: `unlock` refuses when an AI agent runs it. The timers are not a way around that.

## See also

- [Command reference: `unlock`](../cli.md#unlock) and [`lock`](../cli.md#lock)
- [Secrets](../secrets.md)
- [Example: move a fake `.env` file into the vault and put the values back](env-file-round-trip.md)
- [Troubleshooting](../troubleshooting.md)
