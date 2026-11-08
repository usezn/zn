# Example: vault verify, forget and purge

A short walk-through of three [vault commands](../cli.md#vault-verify) that check or remove what the vault keeps on your machine: `zn-gate vault verify`, `zn-gate vault forget` and `zn-gate vault purge`. For the full reference of every vault command, read the [CLI page](../cli.md) and the [secrets page](../secrets.md).

The output below comes from real runs of the commands against a throwaway vault. Two things were changed for reading: messages print the command in the form that works on your machine (for example `npx -y zn-gate@<version> unlock`), and here it is shortened to `zn-gate`; and file paths are shown under `~/.zn`, where the vault lives by default.

All commands run in your own terminal. An AI agent cannot run `vault purge` or `vault verify --acknowledge`.

| Command | What it does | Vault must be | Asks before acting | Reversible |
|---|---|---|---|---|
| `vault verify` | Checks the audit log. Changes nothing. | unlocked | no | not applicable |
| `vault verify --acknowledge` | Accepts the audit log as it is now. | unlocked | yes, the vault asks you to confirm | the warning stays in the log |
| `vault forget [dir]` | Deletes the token map of one project. | locked | no | no |
| `vault purge` | Deletes the vault, its backups and token maps. | locked | yes, you type a phrase (or pass `--yes`) | no |

## Verify the audit log

The vault keeps a local audit log of secret use. Each record is signed and chained to the one before it, so a record that was changed, removed or reordered shows up. `vault verify` checks the whole log. It needs the vault unlocked, because the key for the signatures lives inside the vault.

```bash
npx -y zn-gate unlock
npx -y zn-gate vault verify
```

When the log is intact:

```text
Audit log OK: 1 records, chain and MACs verified.
```

The exit code is 0. The count is the number of records, so a vault that was just created shows `1 records`: the unlock itself is the first record.

With the vault locked, verify cannot check anything. It says so and exits 1:

```text
[zn] vault is locked; run `zn-gate unlock`
```

### When the check fails

To see a failure, one record of a throwaway log was edited by hand. The check then prints:

```text
The audit log did not pass its check (at record 1). Do not delete or edit it: it is the proof of what happened. More: https://usezn.com/docs/zn-gate/troubleshooting/
The vault keeps this warning until you look into it. Keep a copy of the audit log as evidence, then, in your own terminal, run `zn-gate vault verify --acknowledge` to accept the log as it is now.
```

The exit code is 1. Running it again prints the same thing: the vault keeps the warning, also after lock and unlock, until you deal with it. What to do:

1. Do not delete or edit the log. Keep a copy of `~/.zn/audit.jsonl` as evidence.
2. Find out why it changed. The [troubleshooting page](../troubleshooting.md) has the steps.
3. If you know the cause and accept the log as it is, run `zn-gate vault verify --acknowledge` in your own terminal. The vault asks you to confirm. Accepting does not erase the gap: a warning record is written to the log.

Exports and the log view refuse to run while the warning stands. For example, `zn-gate vault log export --otlp` prints `Not exported:` with the reason and tells you to run `vault verify --acknowledge`.

`vault verify` takes no folder and only one option, `--acknowledge`. An unknown option exits 2 with a usage line.

## Forget a project

When zn-gate hides secrets from an agent, it keeps a token map for each project: the list of which marker stands for which value (see the [glossary](../glossary.md)). `vault forget` deletes the stored map of one project. Give it a folder, or run it inside the project to use the current folder.

The vault must be locked, because the running vault may hold the project in memory. With the vault unlocked the command refuses and exits 1:

```text
Lock the vault first (`zn-gate lock`): the daemon may hold this project in memory.
```

Lock it and run the command:

```bash
npx -y zn-gate lock
npx -y zn-gate vault forget ~/projects/demo
```

If the project had a map, the command prints `Forgot the token map of <folder>`. If it had none, as in the throwaway vault used here, it says so and still exits 0:

```text
No token map stored for ~/projects/demo
```

The folder name in that line is an example. The command does not ask for confirmation, and the deletion cannot be undone. It touches only that project's map: the vault, your other projects and the audit log are not changed. More than one folder, or any option, is a usage error and exits 2 (`Unexpected argument "b".` plus the usage line).

## Purge the vault

`vault purge` is the command that deletes the whole vault for good. It removes the secrets and first-use approvals, the vault key (for a passphrase vault; for a vault in the system keychain, the key entry too), the token maps, the audit log, every `vault-backup-*` folder that `vault reset` made, and the session files. Use it when you no longer want any trace of the vault on this machine. If you only lost the passphrase and want to start again while keeping the old vault aside, use `zn-gate vault reset` instead: it never deletes anything.

Before it acts, purge checks three things, each before anything is touched:

- it is not an AI agent that runs it (an agent is refused with `must be run by you in your own terminal, not by an AI agent`);
- this computer does not belong to a zn Team organization (otherwise it refuses and exits 1, because the controls of the organization are kept in the vault);
- the vault is locked (otherwise it says `` [zn] The vault is unlocked. Run `zn-gate lock` first, then `zn-gate vault purge`. `` and exits 1).

Then it lists every file it will delete and waits for you. In a terminal you type the phrase `purge my vault`. Anything else cancels:

```text
Nothing was purged: the phrase did not match. Your vault is as it was.
```

The exit code is 1 when you cancel. Without a terminal, and without `--yes`, it refuses with `zn vault purge needs an interactive terminal`. A script that has no terminal can pass `--yes` to skip the phrase and the terminal. It still lists the files, and an agent still cannot use it.

A run of `zn-gate vault purge --yes` on the throwaway vault printed:

```text
This deletes the vault for good, with every backup. It cannot be undone. These 5 files will be deleted:
  - ~/.zn/vault/identity.age  (vault key (passphrase protected))
  - ~/.zn/vault/keychain.json  (vault settings)
  - ~/.zn/vault/secrets.age  (secrets and first-use approvals)
  - ~/.zn/audit.jsonl  (audit log)
  - ~/.zn/run/.last-prune  (daemon runtime file)
To keep an encrypted copy and start a new vault instead, use `zn-gate vault reset`.
Purged: 5 files deleted, and a new check found none left. Run `zn-gate unlock` to create a new vault.
```

The exit code is 0. After deleting, purge looks again and only then says `Purged`. If a file cannot be removed, it says `The vault was NOT fully purged` and lists what is left, and exits 1. A keychain entry that cannot be removed is reported the same way. Running purge when there is no vault prints `There is no vault here to purge. Nothing was changed.` and exits 0.

Purging cannot be undone: the secrets stored in the vault are gone, so rotate and store again any value you still need with `zn-gate secret set NAME`.
