# Examples: team leave and rejoin

What happens when a developer runs `zn team leave`, what stays on the machine, what the lead sees, and how to join again. For the first day on a team, the join steps and the policy, see [zn Team on a developer machine](../team.md); this page does not repeat them. Organization names, ids and dates below are made up.

## Leave the organization

```bash
zn unlock
zn team leave
```

The vault must be unlocked. If it is not, the command stops and says what to run:

```text
[zn] vault is locked; run `npx -y zn-gate@1.15.0 unlock`
```

(It exits with code `1`; the version in the line is the one you have installed.) `zn team leave` is then confirmed on the vault's own channel (the terminal of `zn unlock --foreground`, or a system dialog), not in the terminal where you typed it. The dialog names the organization and warns that the organization's policy stops applying here and that the administrators will see this machine stop reporting. If you did not run the command yourself, choose Deny.

## What it prints

The server is asked first to revoke this installation, and the answer decides the message. With a working connection, the output looks like this:

```text
Left acme-example. The organization policy no longer applies on this machine.
The server was told: installation inst_example is revoked and its token no longer works.
```

If the server cannot be reached, you still leave at once, and the command exits `0` and says the server was not told:

```text
Left acme-example. The organization policy no longer applies on this machine.
The server was NOT told yet that you left (...): installation inst_example stays on the organization's list, and its token still works there, until a retry succeeds.
```

zn-gate then keeps a small "revocation pending" record in the encrypted vault, only for that retry. It gives the organization no control: no policy, no uploads, no detectors. It is retried on `zn team sync`, on `zn team leave` and every 15 minutes while the vault is unlocked, and zn-gate gives up after 30 days. See [Leaving](../team.md#leaving).

Running it when you are not in an organization prints `Not in an organization.`

## What is removed and what is kept

| Item | After `zn team leave` |
| --- | --- |
| The organization membership in the vault | Removed. |
| The local copy of the organization policy and the team file | Deleted. The restrictions stop applying at once. |
| The upload state and its lock | Deleted. Nothing more is uploaded. |
| Your secrets in the vault and the local audit log | Not touched by the command. Audit records stay on your machine. |
| A "revocation pending" record | Kept only if the server could not be told, and only until a retry works. |

If a local file cannot be deleted (for example a locked file), the command exits `1` and names the files to delete by hand, because the hooks still read them.

## Check the state

```bash
zn team status
```

```text
Not in a zn organization. Join with: zn team join <token> (from your organization admin).
```

If a revocation is still pending, `zn team status` also shows it, with the last error and when zn-gate stops trying.

## What the lead sees

- If the server was told, the installation shows as left in the organization's activity log and its token stops working.
- If it was not told yet, the installation stays on the list of connected installations until a retry works. After 30 days without success, the lead can remove the installation from the dashboard.
- Either way, the machine stops reporting, and the dashboard shows each machine's last policy version and last upload, so the gap is visible.

## Join again

Ask the lead for a join token if your old one is invalid, expired or used up, then:

```bash
zn unlock
zn team join -
```

The join is confirmed in the vault's dialog like the first one. A new membership keeps its own token, so an earlier pending revocation never affects it.

Audit records are sent only from the moment you join. To send the earlier records too, join with the history flag. This can only be added at the first join of an installation, so if you joined without it and want it now, leave first:

```bash
zn team leave
zn team join - --include-history
```

The vault's dialog then says so in its own warning, and you can still choose Deny.

## See also

- [zn Team on a developer machine](../team.md): the commands, the dialogs and what is sent.
- [Team quick guide](../team-quick-guide.md): the short version.
