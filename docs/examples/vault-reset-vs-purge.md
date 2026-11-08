# Example: vault reset or vault purge

A walk through the two commands that start the vault again, and when to use which. `zn vault reset` sets the old vault aside and starts a new, empty one. `zn vault purge` deletes the vault for good, with every backup. All names and values below are made up. The output was captured on a throwaway machine with a passphrase vault, with the folder shortened to `~`; the hints in the output are shown with `zn` as the command name. On a computer with a system keychain, both commands also deal with the vault key stored there, and say so.

Both are for the person at the keyboard. They refuse to run inside an agent's shell, they need the vault to be locked, and they refuse on a computer that belongs to a zn Team organization (its controls live in the vault). For the files each one touches, see [Secrets](../secrets.md).

## Which one

| You want to | Use | What happens to the old values |
| --- | --- | --- |
| Get out after forgetting the passphrase | `zn vault reset` | Kept in an encrypted backup, but nobody can open it without the old passphrase. |
| Start clean and keep an encrypted copy for now | `zn vault reset` | Same: kept, encrypted. |
| Remove every trace of the vault from this computer | `zn vault purge` | Deleted, with the backups. |
| Remove one secret | `zn secret rm NAME` | See Remove and replace a stored secret. |

A common order is `reset` first and, when you are sure you do not need the backup, `purge` after.

## 1. Lock the vault first

With the vault unlocked, `reset` stops before it changes anything:

```bash
zn vault reset
```

```text
[zn] The vault is unlocked. Run `zn lock` first, then `zn vault reset`.
```

```bash
zn lock
```

```text
Vault locked.
```

## 2. Reset

```bash
zn vault reset
```

zn explains what will happen and waits for you to type the phrase `reset my vault`. Typing anything else changes nothing:

```text
This starts a new, empty vault. The old one is set aside, not deleted.
  - Every secret stored in it is lost. Without the old passphrase nobody can read them again, zn included.
  - The audit log of secret use starts again from zero.
  - Your .env files and shadowed projects keep their markers; store the values again afterwards.
To go on, type "reset my vault" and press Enter: wrong phrase
Nothing was reset: the phrase did not match. Your vault is as it was.
```

With the right phrase:

```text
To go on, type "reset my vault" and press Enter: reset my vault
Old vault saved in ~/.zn/vault-backup-20261108-115505 (it stays encrypted). `zn vault purge` deletes it, with every other backup, when you no longer need it.
Done. Run `zn unlock` to create the new vault, then store your values again:
  zn env shadow .env        move the values of a .env file into the vault
  zn secret set NAME        store one value (typed at a hidden prompt)
```

The `~/.zn` folder now holds the backup, `vault-backup-<date>-<time>`, which contains the old `audit.jsonl` and `vault` folder. The old vault no longer exists as the active one, so `zn secret list` says the vault is locked and `zn unlock` creates a new one:

```text
Created a new vault (passphrase) in ~/.zn/vault
```

Store your values again, and the log starts from zero:

```text
2026-11-08T11:55:07.684Z  allow  -  unlock  -  -    ttl:480m
2026-11-08T11:55:08.959Z  allow  NEW_TOKEN  set  -  -    created
chain: valid, 2 records
```

## 3. Purge

When the backup is no longer needed, lock the vault and run:

```bash
zn lock
zn vault purge
```

It lists every file it will delete and asks for the phrase `purge my vault`. The list is what makes it safe to read before you answer:

```text
This deletes the vault for good, with every backup. It cannot be undone. These 9 files will be deleted:
  - ~/.zn/vault/identity.age  (vault key (passphrase protected))
  - ~/.zn/vault/keychain.json  (vault settings)
  - ~/.zn/vault/secrets.age  (secrets and first-use approvals)
  - ~/.zn/audit.jsonl  (audit log)
  - ~/.zn/vault-backup-20261108-115505/audit.jsonl  (backup (vault-backup-20261108-115505))
  - ~/.zn/vault-backup-20261108-115505/vault/identity.age  (backup (vault-backup-20261108-115505))
  - ~/.zn/vault-backup-20261108-115505/vault/keychain.json  (backup (vault-backup-20261108-115505))
  - ~/.zn/vault-backup-20261108-115505/vault/secrets.age  (backup (vault-backup-20261108-115505))
  - ~/.zn/run/.last-prune  (daemon runtime file)
To keep an encrypted copy and start a new vault instead, use `zn vault reset`.
To go on, type "purge my vault" and press Enter: purge my vault
Purged: 9 files deleted, and a new check found none left. Run `zn unlock` to create a new vault.
```

A wrong phrase prints `Nothing was purged: the phrase did not match. Your vault is as it was.` and exits with `1`. For a script with no terminal, `zn vault purge --yes` skips the phrase; it still refuses to run inside an agent. zn never says "deleted" when something is left: if a file cannot be removed, it names it and exits with `1`.

Run again, both commands say there is nothing to do and change nothing:

```text
There is no vault here to purge. Nothing was changed.
There is no vault here to reset. Run `zn unlock` to create one.
```

## What to check

- Before either command, make sure you do not need the old values: neither one can bring them back.
- After a reset, store your values again and rotate any secret you cannot re-enter.
- After a purge, `zn unlock` creates a vault from nothing, and the old backups are gone.

## See also

- [Secrets](../secrets.md): the files in the zn folder and what removes each one.
