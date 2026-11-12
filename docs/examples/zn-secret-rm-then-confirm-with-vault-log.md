# Example: remove a secret, then confirm it in the vault log

A worked example of auditing a removal: you delete a secret from the vault with `zn-gate secret rm`, then read the vault log to see the line that records it. The output below comes from real runs against a throwaway vault with made-up values. The times are only examples. For the full list of secret commands, see the [secrets page](../secrets.md) and the [command line reference](../cli.md#secret-rm).

Run every command in your own terminal. `secret rm` refuses to run without one, so an agent cannot remove a secret for you.

## Goal

Remove one secret you no longer need, and be able to show afterwards that it was removed and when.

## Before: what the vault holds

The vault must be unlocked (`zn-gate unlock`). List the secrets:

```bash
zn-gate secret list
```

```text
  EXAMPLE_API_KEY               proxy   hosts=api.example.com
  EXAMPLE_TOKEN                 env     commands=printenv
```

The list shows names and rules, never values. Here `EXAMPLE_TOKEN` is the one to remove.

## Remove it

```bash
zn-gate secret rm EXAMPLE_TOKEN
```

The command asks before it acts, so it needs a terminal where you can type. The default answer is no:

```text
Remove EXAMPLE_TOKEN? [y/N] y
Removed EXAMPLE_TOKEN.
```

Other things that can happen:

- You answer `n`, or just press Enter: it prints `Kept EXAMPLE_TOKEN.` and exits with `1`. Nothing changed.
- There is no terminal, as when a script or an agent runs it: it refuses with `zn secret: Not allowed: zn secret rm needs an interactive terminal. Open a terminal window yourself and run it there.` and exits with `77`.
- The name is not in the vault: `zn secret: Not found: EXAMPLE_TOKEN is not in the vault`, exit `1`.
- The vault is locked: it tells you to run `zn-gate unlock` first, and exits with `1`.

`secret remove` is the same command as `secret rm`.

## After: the secret is gone

```bash
zn-gate secret list
```

```text
  EXAMPLE_API_KEY               proxy   hosts=api.example.com
```

Removing a secret also removes the first-use approvals it had. If you store a new value under the same name later, zn-gate asks for approval again.

## Confirm with the vault log

The list shows the present. The log shows what happened. Read only the lines of the secret you removed (see [narrow the vault log to one secret](zn-vault-log-filtering-by-secret-name.md) for the filter):

```bash
zn-gate secret log | grep -w EXAMPLE_TOKEN
```

```text
2026-11-11T14:21:51.879Z  allow  EXAMPLE_TOKEN  set  -  -    created
2026-11-11T14:21:53.604Z  allow  EXAMPLE_TOKEN  remove  -  -
```

The second line is the removal. It says, in order: the time (UTC), that the vault allowed it, the name, and the mode `remove`. The agent and tool columns hold `-`: the log does not name who ran the command. The line before it is when the secret was stored. Nothing in the log holds a value.

The log keeps the old lines. Removing a secret adds a line; it does not delete the earlier ones.

## Check that the log was not changed

A removal line is only useful as proof if the log itself is sound. Run:

```bash
zn-gate vault verify
```

```text
Audit log OK: 5 records, chain and MACs verified.
```

Each record is signed and chained to the one before it, so a line that was edited or taken out would fail this check (see [vault verify, forget and purge](vault-verify-and-forget.md)). The count is the number of records of the whole vault, so yours will differ.

## What the log cannot tell you

- It does not hold the value, so it cannot show what was in the secret.
- Removing a secret from the vault does not change the service that issued it. If the value was ever exposed, rotate it there as well.
- The vault log is a local file. It shows what this vault did, not what happened on other computers.

## See also

- [Secrets: keep secrets out of your coding agent](../secrets.md)
- [Example: narrow the vault log to one secret](zn-vault-log-filtering-by-secret-name.md)
- [Example: vault verify, forget and purge](vault-verify-and-forget.md)
- [Command line reference](../cli.md#secret-rm): `secret rm` and `secret list`.
