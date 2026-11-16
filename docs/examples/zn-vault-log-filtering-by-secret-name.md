# Example: narrow the vault log to one secret

A worked example of reading the vault log for a single secret. The log lists every event of every secret, and `zn-gate secret log` has no option to pick one name, so this page shows how to cut it down with `grep` or `awk`, and what each line you find means. The output below comes from real runs against a throwaway vault with made-up values. The times are only examples. For the other vault commands, see the [secrets page](../secrets.md) and the [command line reference](../cli.md#secret-log).

`zn-gate secret log` and `zn-gate vault log` are the same command. The log only holds names and facts, never a value.

## Goal

See only what happened to one secret, for example `EXAMPLE_TOKEN`, without reading the lines of the others.

## The whole log first

With the vault unlocked, the log is checked as it is shown. Here the vault holds three fake secrets:

```bash
zn-gate secret log
```

```text
2026-11-11T14:20:32.807Z  allow  -  unlock  -  -    ttl:480m
2026-11-11T14:20:33.625Z  allow  EXAMPLE_API_KEY  set  -  -    created
2026-11-11T14:20:34.428Z  allow  EXAMPLE_TOKEN  set  -  -    created
2026-11-11T14:20:35.239Z  allow  EXAMPLE_TOKEN_OLD  set  -  -    created
chain: valid, 4 records
```

Each line is one event. The columns, separated by two spaces, are:

1. the time, in UTC;
2. the decision, such as `allow` or `deny`;
3. the name of the secret, or `-` when the event is not about one secret (the unlock and the lock);
4. the mode: `set` when a value was stored, `remove` when one was deleted, `unlock` and `lock` for the vault itself, and `env`, `proxy` or `file` for the way a command was given a secret (see the [secrets page](../secrets.md));
5. the agent, or `-` when there is none;
6. the tool, or `-` when there is none;
7. the program or the host, empty when there is none;
8. the reason, for example `created`.

The last line is not an event. It says whether the chain of signatures checked out.

## Filter by name with `grep`

The command has one option, `--since`, and none for a name. Do not look for a name option: use a pipe to filter the log instead:

```bash
zn-gate secret log | grep -w EXAMPLE_TOKEN
```

```text
2026-11-11T14:20:34.428Z  allow  EXAMPLE_TOKEN  set  -  -    created
```

The `-w` matters. Without it, `grep EXAMPLE_TOKEN` also prints the line of `EXAMPLE_TOKEN_OLD`, because that name begins with the same letters. With `-w`, only the exact name matches.

If the name has no event, `grep` prints nothing and exits with `1`. That is not an error of zn-gate.

## Filter by the name column with `awk`

`-w` still matches the name anywhere in the line. When you want the name only in the third column, use `awk`:

```bash
zn-gate secret log | awk '$3 == "EXAMPLE_TOKEN"'
```

It prints the same line here. The name of a secret is always in the third column, so this matches only that column.

## Narrow it by time

`--since` keeps only the events from the last while. It takes a number with `s`, `m`, `h` or `d` (for example `30m`, `1h` or `1d`), or a date and time such as `2026-11-11T14:20:40Z`:

```bash
zn-gate secret log --since 1h | grep -w EXAMPLE_API_KEY
```

```text
2026-11-11T14:20:33.625Z  allow  EXAMPLE_API_KEY  set  -  -    created
```

A value it cannot read, such as `--since abc`, is refused and the command exits with `1`. Use a number with `s`, `m`, `h` or `d`, or a full date and time.

## What a hit tells you

| Line | What it means |
| --- | --- |
| `allow  NAME  set  -  -    created` | You stored `NAME` in the vault. |
| `allow  NAME  remove` | You removed `NAME` (the [next example](zn-secret-rm-then-confirm-with-vault-log.md) shows it). |
| `deny  NAME  env ...` | A command asked to use `NAME` and was refused. The last words say why. |

Removing a secret does not remove its old lines. The log keeps the whole story of a name, including the lines from before it was removed.

## Two things a name filter drops

- The `unlock` and `lock` lines carry no secret name, so a filter by name never shows them. Print the whole log when you need to know whether the vault was unlocked at some time.
- The `chain:` line at the end is dropped too. A filtered list is not checked for you. Run `zn-gate vault verify` to check the chain, or read the last line of the unfiltered `zn-gate secret log`.

With the vault locked the command still prints the events, and the last line says `chain: not checked`, because the key for the signatures lives inside the vault. Unlock it and run `zn-gate vault verify` when you need a checked log.

## See also

- [Example: vault verify, forget and purge](vault-verify-and-forget.md): checking the whole log.
- [Command line reference](../cli.md#secret-log): `secret log` and `vault log`.
