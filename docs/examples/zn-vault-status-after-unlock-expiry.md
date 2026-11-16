# Example: reading vault status after the unlock time ran out

The vault does not stay open for ever. `zn-gate unlock` opens it for a session of up to 24 hours, and `zn-gate vault status` tells you where you are. This page shows the status before and after the time ran out, what the vault says to other commands, and how to continue. For the full reference, read the [CLI page](../cli.md#unlock) and the [secrets page](../secrets.md).

The output below comes from a real run against a throwaway vault. To make the wait short, the session was set to the shortest value, one minute. Messages print the command in the form that works on your machine (for example `npx -y zn-gate@<version> unlock`), and here it is shortened to `zn-gate`. The home folder is shown as `~`, and the time and version are from that run. The test machine had no desktop, so `unlock` also printed a note about system dialogs; it is left out here.

## 1. Unlock with a short session

`--ttl` is the length of the session. It takes a number with `s`, `m` or `h`, between 1 minute and 24 hours. `--idle` is how long the vault may sit unused before it locks itself; it was left at its default of 30 minutes here.

```bash
zn-gate unlock --ttl 1m
```

```text
Vault unlocked: locks after 30 min idle, or at 15:25 (in 1 min) at the latest. Run `zn-gate lock` to lock now.
```

The first run also creates the vault and asks for a passphrase. The time in the message is in your local time.

## 2. Status while it is open

```bash
zn-gate vault status
```

```text
Vault: unlocked (backend passphrase, locks after 30 min idle, or at 15:25 (in 1 min) at the latest, zn-gate 1.15.0)
Location: ~/.zn/vault
```

The exit code is 0. The line gives the backend that holds the key, the two times at which the vault locks, and the version of the running vault.

## 3. Status after the session ended

A minute later, the same command says:

```text
Vault: locked (backend passphrase)
Location: ~/.zn/vault
```

The exit code is still 0: `vault status` only reports. It does not say whether the vault locked because the time ran out, because it was idle or because you ran `zn-gate lock`: a vault you locked yourself printed the same two lines.

The log keeps the difference. `zn-gate vault log` has a record of the unlock, with the session length, and a record when the session ended on its own:

```text
2026-11-11T15:24:32.302Z  allow  -  unlock  -  -    ttl:1m
2026-11-11T15:24:33.516Z  allow  DEMO_TOKEN  set  -  -    created
2026-11-11T15:25:32.300Z  allow  -  expire  -  -    expired
```

The times are in UTC. With the vault locked, `vault log` cannot check the chain of the log and says so on its last line; unlock first if you want that check.

## 4. What other commands say

A command that needs the vault does not wait or ask. It exits with 1 and tells you what to do:

```bash
zn-gate secret list
```

```text
zn secret: Your secret vault is locked. Unlock it in this terminal with: zn-gate unlock. Then run this command again.
```

Nothing was lost: the secrets are still in the vault.

## 5. Unlock again and continue

```bash
zn-gate unlock
zn-gate vault status
zn-gate secret list
```

The vault asks for its passphrase, and then it is open for a new session. In the throwaway run, the new session used the defaults and the list was back as it was:

```text
Vault unlocked: locks after 30 min idle, or at 23:20 (in 8 h) at the latest. Run `zn-gate lock` to lock now.
Vault: unlocked (backend passphrase, locks after 30 min idle, or at 23:20 (in 8 h) at the latest, zn-gate 1.15.0)
  DEMO_TOKEN                    proxy
```

Without `--ttl` the session lasts 8 hours at most. If you want a longer or shorter one, say so each time you unlock.

## Before the vault status exists

Before the first unlock, `vault status` says that no vault exists yet and exits with 0:

```text
Vault: not created yet (run `zn-gate unlock`).
```

## Related

- [`unlock` and `vault status` in the command reference](../cli.md#unlock)
- [Secrets in the vault](../secrets.md)
- [Vault verify, forget and purge](vault-verify-and-forget.md)
