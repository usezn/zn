# Vault cleanup after leaving a team

This example follows one machine that leaves a zn Team organization with
`zn-gate team leave`. It shows what the leave already removes, and when the
vault commands `vault forget` and `vault purge` are the right next step. All
names and values are made up.

## What `team leave` does

Run it in your own terminal:

```bash
zn-gate team leave
```

In this order (`lib/team/daemon-ops.js`, `teamLeave`):

1. It tells the server to revoke this installation, with the installation's
   own token.
2. It removes the organization from the vault.
3. It deletes four local files: the team file, the policy file, the upload
   state and the upload lock (`lib/team/daemon-ops.js:134-136`).

If one of those files cannot be deleted, the command exits `1` and names the
file, because the hooks still read it. Delete that file by hand and run
`zn-gate team status` to check (`lib/team/cli.js:248-251`).

After a successful leave, the organization's policy stops applying on this
machine at once (`docs/cli.md`, `team leave`).

## What `team leave` does not touch

The four files above are the whole list. `team leave` does not remove:

- your secrets in the vault;
- the token map of each project, the list that matches the markers in a
  project's files to the real values (`docs/files-and-folders.md`, the
  `vault/<32 hex characters>.age` row);
- the vault audit log;
- `vault-backup-*` folders made by `vault reset`.

So after leaving, the vault can still hold project data from when you were a
member. Those are the things the vault commands are for.

## Check the leave first

```bash
zn-gate team status
```

If the server could not be told, the output says so. The installation then
keeps a "revocation pending" record in the vault, with its own token, for up to
30 days. It is retried on `zn-gate team sync`, on `zn-gate team leave`, and every
15 minutes while the vault is unlocked (`docs/team.md`, "Leaving"). The record
gives the organization no control over this machine, so you do not need to
delete it. Run `zn-gate team sync` or leave again once the network is back.

## When to use `vault forget`

Use it when you want to drop the token map of one project folder, for example a
project you no longer work on and whose markers you do not need any more.

```bash
zn-gate lock
zn-gate vault forget ~/projects/old-app
```

Rules from `docs/cli.md`, `vault forget`:

- The vault must be locked. Otherwise the command exits `1`.
- It takes one folder. The default is the current folder.
- It does not delete any secret value. Only the token map of that folder goes.

Once a token map is gone, the markers in that project's files can no longer be
turned back into values by zn. Run `zn-gate env unshadow` first if you want the
values back in a `.env` file (`docs/cli.md`, `env unshadow`).

## When to use `vault purge`

Use `vault purge` only if you want to delete the whole vault. It lists every
file it will remove, asks you to type `purge my vault`, and cannot be undone
(`docs/cli.md`, `vault purge`).

The vault commands `reset` and `purge` refuse on a machine that belongs to a
zn Team organization (`docs/cli.md`). After the leave, this machine no longer
belongs to one, so that refusal should no longer apply. An AI agent can never
run `purge`.

## Order of steps

1. `zn-gate team leave` (in your terminal).
2. `zn-gate team status`: check the result, and whether a revocation is pending.
3. `zn-gate vault status`: see whether the vault is locked.
4. Optional: `zn-gate lock`, then `zn-gate vault forget <folder>` for each
   project you no longer need the token map of.
5. Optional, and only if you are sure: `zn-gate vault purge`.

For the commands in full, see [cli.md](../cli.md#vault) and
[team.md](../team.md#leaving). The shorter example for the vault commands is
[vault-verify-and-forget.md](vault-verify-and-forget.md).
