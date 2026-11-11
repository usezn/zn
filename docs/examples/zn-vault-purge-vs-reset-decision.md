# Example: `vault purge`, `vault reset` or `vault forget`

A decision list for the moment you want something gone from the vault. There are three commands that remove vault data, and they differ in how much they remove and whether anything is kept aside. All values are made up. For every option, read the [command line reference](../cli.md#vault) and the [secrets page](../secrets.md).

The output below comes from real runs against a throwaway vault. Three things were changed for reading: messages print the command in the form that works on your machine (for example `npx -y zn-gate@<version> unlock`), and here it is shortened to `zn-gate`; paths are shown under `~/.zn`; and the time stamp in a backup folder name is shown as `<date>-<time>`.

All three need the vault to be **locked** first (`zn-gate lock`). `reset` needs a person at a terminal, and so does `purge` unless a script passes `--yes` (an AI agent can never run it). Both refuse on a computer that belongs to a zn Team organization.

## Pick by situation

1. **I only want to remove one secret.** None of these three: use `zn-gate secret rm NAME`. See [`secret rm` or `vault forget`](zn-secret-rm-vs-vault-forget.md).
2. **I finished with one project.** `zn-gate vault forget <folder>`. It deletes the token map of that folder and nothing else.
3. **I lost the vault passphrase.** `zn-gate vault reset`. It sets the old vault aside in an encrypted backup and starts a new, empty one. The values in the old vault are lost, but nothing is deleted.
4. **I want no trace of the vault on this machine.** `zn-gate vault purge`. It deletes the vault, the token maps, the audit log and every backup, and checks that none is left.
5. **I reset the vault and no longer need the old backup.** `zn-gate vault purge`. There is no command that deletes one backup alone.

| | `vault forget` | `vault reset` | `vault purge` |
|---|---|---|---|
| Removes | one project's token map | the vault and its audit log, set aside as a backup | the vault, token maps, audit log and backups, plus a session key if one is left behind |
| Keeps a copy | no | yes, an encrypted `vault-backup-<date>-<time>` folder | no |
| Asks before acting | no | yes, you type `reset my vault` | yes, you type `purge my vault` (or pass `--yes`) |
| Can be undone | no | nothing is deleted, but the old values open only with the old passphrase | no |
| Leaves a vault behind | yes | no: the next `unlock` creates a new, empty one | no |

## If you lost the passphrase (situation 3)

With the vault unlocked, `reset` refuses and tells you what to do first:

```text
$ zn-gate vault reset
[zn] The vault is unlocked. Run `zn-gate lock` first, then `zn-gate vault reset`.
```

The exit code is 1. Lock the vault, then run it. Anything other than the phrase cancels, with exit code 1, and nothing changes:

```text
$ zn-gate vault reset
This starts a new, empty vault. The old one is set aside, not deleted.
  - Every secret stored in it is lost. Without the old passphrase nobody can read them again, zn included.
  - The audit log of secret use starts again from zero.
  - Your .env files and shadowed projects keep their markers; store the values again afterwards.
To go on, type "reset my vault" and press Enter: no
Nothing was reset: the phrase did not match. Your vault is as it was.
```

With the phrase it goes ahead, with exit code 0:

```text
To go on, type "reset my vault" and press Enter: reset my vault
Old vault saved in ~/.zn/vault-backup-<date>-<time> (it stays encrypted). `zn-gate vault purge` deletes it, with every other backup, when you no longer need it.
Done. Run `zn-gate unlock` to create the new vault, then store your values again:
  zn-gate env shadow .env        move the values of a .env file into the vault
  zn-gate secret set NAME        store one value (typed at a hidden prompt)
```

After the reset the `vault` folder is empty, the old files are in the backup folder, and the next `zn-gate unlock` creates a new vault, with `zn-gate secret list` showing nothing stored:

```text
No secrets stored. Add one with: zn secret set NAME   or import a .env: zn env shadow .env
```

Without a terminal, `reset` refuses and exits 1 (`zn vault reset needs an interactive terminal`). With no vault at all it prints `There is no vault here to reset.` with a hint to run `zn-gate unlock`, and exits 0.

Then store your values again, and rotate any secret you cannot enter again.

## To wipe everything (situations 4 and 5)

`purge` first lists every file it will delete, and only then asks. In the throwaway vault there was a new vault and the backup from the reset above, so the list had 10 files:

```text
$ zn-gate vault purge
This deletes the vault for good, with every backup. It cannot be undone. These 10 files will be deleted:
  - ~/.zn/vault/identity.age  (vault key (passphrase protected))
  - ~/.zn/vault/keychain.json  (vault settings)
  - ~/.zn/vault/secrets.age  (secrets and first-use approvals)
  - ~/.zn/audit.jsonl  (audit log)
  - ~/.zn/vault-backup-<date>-<time>/audit.jsonl  (backup (vault-backup-<date>-<time>))
  - ~/.zn/vault-backup-<date>-<time>/vault/<32 hex characters>.age  (backup (vault-backup-<date>-<time>))
  - ~/.zn/vault-backup-<date>-<time>/vault/identity.age  (backup (vault-backup-<date>-<time>))
  - ~/.zn/vault-backup-<date>-<time>/vault/keychain.json  (backup (vault-backup-<date>-<time>))
  - ~/.zn/vault-backup-<date>-<time>/vault/secrets.age  (backup (vault-backup-<date>-<time>))
  - ~/.zn/run/.last-prune  (daemon runtime file)
To keep an encrypted copy and start a new vault instead, use `zn-gate vault reset`.
To go on, type "purge my vault" and press Enter: nope
Nothing was purged: the phrase did not match. Your vault is as it was.
```

No session key is in this list: locking the vault already removed it. If one were left in `~/.zn/run`, `purge` would list it and delete it too.

The exit code is 1. Run it again and type the phrase:

```text
To go on, type "purge my vault" and press Enter: purge my vault
Purged: 10 files deleted, and a new check found none left. Run `zn-gate unlock` to create a new vault.
```

The exit code is 0, and only the empty `~/.zn` folder is left. The second run finds nothing to do:

```text
There is no vault here to purge. Nothing was changed.
```

Purging cannot be undone: the secrets stored in the vault are gone. A script with no terminal can pass `--yes` to skip the phrase, but an AI agent can never run `purge`. For a walk-through of what `purge` refuses and why, see [vault verify, forget and purge](vault-verify-and-forget.md).

## For one project (situation 2)

`vault forget` is the small one. It asks nothing and deletes only the token map of one folder:

```text
$ zn-gate lock
Vault locked.
$ zn-gate vault forget ~/projects/demo
Forgot the token map of ~/projects/demo
```

The exit code is 0. A second run prints `No token map stored for ~/projects/demo`. More in [`secret rm` or `vault forget`](zn-secret-rm-vs-vault-forget.md).

## A command that does not exist

There is no `vault wipe` or `vault delete`. An unknown vault command prints the usage line and exits 2:

```text
usage: zn-gate unlock | zn-gate lock | zn-gate vault status | zn-gate vault verify | zn-gate vault log [--since 1h] | zn-gate vault forget [dir] | zn-gate vault reset | zn-gate vault purge
```

`zn-gate uninstall` can delete the vault too, as the answer to its second question. See [uninstall](../uninstall.md).

## Further reading

- [Secrets and the vault](../secrets.md)
- [Troubleshooting: you forgot the vault passphrase](../troubleshooting.md)
- [Command line reference: `vault reset`](../cli.md#vault-reset) and [`vault purge`](../cli.md#vault-purge)
