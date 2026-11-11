# Example: what stays on disk after `zn team leave`

A checklist for the day after you leave a zn Team organization. It says what `zn team leave` removes, what it keeps on purpose, what the command asks you to delete by hand, and which commands show that nothing of the organization is left. All names in the examples are made up. The background is in [Leaving](../team.md#leaving) and in [Files and folders](../files-and-folders.md).

Run the commands yourself, in your own terminal.

## What `zn team leave` removes

The command first asks the server to revoke this installation. It then removes the membership from the encrypted vault and deletes four files in your `~/.zn` folder one by one:

| File | What it was |
| --- | --- |
| `team.json` | The readable copy of the membership, without the install token. |
| `org-policy.json` | The readable copy of the organization's policy. |
| `team-upload.json` | The state of the audit upload. |
| `team-upload.lock` | The lock of the audit upload. |

From that moment the organization's policy, detectors and uploads no longer apply on this machine.

## What stays on disk

These files and settings are yours and `zn team leave` does not touch them:

- **The vault and your secrets.** Leaving does not delete the vault. Your own secrets stay in it.
- **The vault audit log (`audit.jsonl`).** Leaving adds a record that you left. It keeps the earlier records, including those from the time you were in the organization.
- **The decision log (`evidence.jsonl`) and `stats.json`.** They are your local logs and counters.
- **`config.json`.** Your own settings.
- **The hooks in your agent's settings and the launcher scripts in `~/.zn/hooks`.** zn-gate keeps protecting your agent with its own rules. To remove them, use [`hooks uninstall`](../cli.md#hooks) or [`uninstall`](../uninstall.md).
- **Managed settings your admin deployed with device management.** `zn team managed-config` only prints those files; zn-gate never wrote them, so it does not remove them. Ask whoever manages the machine.
- **`team-notice.json`, if it exists.** It remembers which team notices a hook already showed you. The leave command does not delete it. It holds no secret, and you can delete it by hand.

## The one case where you must delete files by hand

If one of the four files cannot be deleted (a locked file, for example), the vault no longer holds the membership, but the hooks still read the copy on disk. The command then exits `1` and names the file:

```text
Left org_example in the vault.
[zn] Some local files could not be deleted. Delete them yourself, because the hooks still read them: /path/to/.zn/team.json
```

The organization name and the path are examples. Delete the file named in the message, then run the check in the next section. This is the only case where the command asks you to delete something yourself.

## Check that nothing is left

```bash
zn team status
```

When this machine is not in an organization and the server was told, the output is one line:

```text
Not in a zn organization. Join with: zn team join <token> (from your organization admin).
```

Then check that the four files are gone. On Linux and macOS:

```bash
ls ~/.zn
```

The list must not show `team.json`, `org-policy.json`, `team-upload.json` or `team-upload.lock`.

## When the server was not told

If the server could not be asked (offline, a server error, a rate limit), the machine still leaves at once and the command exits `0`, but it prints that the server was not told yet. zn-gate then keeps a small "revocation pending" record in the encrypted vault. It holds the install token, the organization, the API address and the time. It gives the organization no control: no policy, no uploads, no detectors.

`zn team status` shows it, for example:

```text
Not in a zn organization. Join with: zn team join <token> (from your organization admin).
Revocation pending since 2026-11-11T09:00:00.000Z (installation inst_example, org_example): last error could not ask the server (offline).
  The server was not told that this installation left, so its token still works there. Next step: `zn team sync` retries now (zn also retries every 15 minutes while the vault is unlocked) until 2026-12-11T09:00:00.000Z, when it stops; an admin can then remove the installation from the dashboard.
```

The installation id, the dates and the error in this example are made up. The lines are built the way `zn team status` builds them; they were not copied from a run against a real server.

To finish the job, go online, unlock the vault and run:

```bash
zn unlock
zn team sync
```

The record is removed when the server confirms, or answers that the token is no longer valid. zn-gate gives up after 30 days; from then on, ask an organization admin to remove the installation from the dashboard.

## If you want no trace of the vault at all

Leaving the organization does not delete the vault. If you also want the vault gone, lock it and use [`vault purge`](../cli.md#vault-purge), which lists every file before it deletes anything. It refuses on a machine that still belongs to an organization, so do it after the leave. If a revocation is still pending (see above), let it finish first: the pending record lives in the vault, so purging deletes it. Deleting cannot be undone: put your `.env` values back first ([how](../uninstall.md#4-your-env-files-and-the-vault)). What `vault purge` asks and prints is in [Vault verify, forget and purge](vault-verify-and-forget.md).

## More

- [Leaving, in the zn Team page](../team.md#leaving)
- [`team leave` in the command reference](../cli.md#team-leave) and [`team status`](../cli.md#team-status)
- [Every file zn-gate keeps, and how to delete it](../files-and-folders.md)
- [Example: the first day of zn Team](team-first-day.md)
