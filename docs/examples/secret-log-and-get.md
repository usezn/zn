# Example: read the secret access log

A walk through `zn secret log`, which shows who used which secret, where and when, and through the answer you get when you ask zn to print a secret (`zn secret get`). There is no way to print a value: the log is how you see that a secret was used without ever seeing it. All names and values below are made up. The output was captured on a throwaway machine, with the vault folder shortened to `~`; the hints in the output are shown with `zn` as the command name.

`zn secret log` and `zn vault log` are the same command. The log holds only metadata, never a value and never a hash of one. For the rest of the audit tools, see [Audit](../audit.md).

## 1. Read the log

```bash
zn secret log
```

```text
2026-11-08T11:54:27.657Z  allow  -  unlock  -  -    ttl:480m
2026-11-08T11:54:28.814Z  allow  DEMO_TOKEN  set  -  -    created
2026-11-08T11:54:29.117Z  deny  DEMO_TOKEN  set  -  -    no_confirmation_channel
2026-11-08T11:54:32.137Z  allow  DEMO_TOKEN  remove  -  -    
2026-11-08T11:54:33.915Z  allow  DEMO_TOKEN  set  -  -    created
2026-11-08T11:54:35.192Z  allow  DEMO_TOKEN  set  -  -    updated
chain: valid, 6 records
```

Each line has eight fields, separated by two spaces. A `-` means the field has no value for that line.

| Field | In the first line | What it is |
| --- | --- | --- |
| Time | `2026-11-08T11:54:27.657Z` | When it happened, in UTC. |
| Decision | `allow` | What zn did: `allow`, `deny`, `ask:yes`, `ask:no`, `warn` and a few others. |
| Secret | `-` | The secret's name. Unlocking the vault involves no one secret, so it is `-`. |
| Kind | `unlock` | What kind of event: `unlock`, `lock`, `set`, `remove`, or how a secret was used (`proxy`, `env`, `file`). |
| Agent | `-` | Which agent asked, when one did. |
| Tool | `-` | Which tool of that agent. |
| Command or host | (empty) | The command (`psql`) or host (`api.example.com`) the secret was used with. |
| Reason | `ttl:480m` | A short code with the detail: here the vault will lock after 480 minutes. |

Reading the sample from the top:

- `unlock`: the vault was unlocked, for at most 8 hours.
- `set ... created`: `DEMO_TOKEN` was stored.
- `deny ... no_confirmation_channel`: a change to the secret's settings was refused, because the machine had no dialog to ask the person (zn asks outside the agent, and does not guess). Nothing was changed.
- `remove`, then `set ... created`, then `set ... updated`: the secret was removed, stored again, and replaced.

The last line is the check of the log itself: `chain: valid, 6 records`. Each record is chained to the one before it with a key kept inside the vault, so an edited or deleted line breaks the chain.

## 2. Look only at the recent part

```bash
zn secret log --since 1h
```

`--since` takes a number and a unit, such as `30m`, `1h` or `7d`. It prints the same format, with only the records since then, and still checks the whole chain.

## 3. When the vault is locked

With the vault locked, the log is still printed, but zn cannot check it:

```text
2026-11-08T11:55:00.397Z  allow  -  lock  -  -    lock
chain: not checked: the vault is locked or unreachable (run `zn unlock`, then `zn vault verify`)
```

(The records above that line are the same as before and are left out.) Unlock the vault, then run `zn vault verify` for the full check:

```text
Audit log OK: 6 records, chain and MACs verified.
```

## 4. When the check fails

If a line was changed by hand, an unlocked vault refuses to show the log. To show it, one record of the sample file was edited on the throwaway machine; its `deny` was changed to `allow`:

```text
chain: BROKEN: bad mac (record 3)
The log is not shown because it did not verify. Keep a copy of ~/.zn/audit.jsonl as evidence and run `zn vault verify`.
```

The exit code is `1`. Do not delete or fix the file: it is the proof of what happened. `zn vault verify` names the record, and tells you how to accept the log as it is once you have looked into it (`zn vault verify --acknowledge`, in your own terminal).

## 5. Asking zn to print a secret

```bash
zn secret get DEMO_TOKEN
```

```text
zn secret: Not allowed: zn does not print secret values. To use one in a command, run: zn run --secrets NAME -- <command>
```

The exit code is `77` (not allowed). `zn secret reveal` gives the same answer. It is by design: an agent could run the command too. Use the value without seeing it, through `zn run --secrets NAME -- <command>`, and read the use afterwards in the log.

## What to check

- The last line says `chain: valid`. Anything else, read it before you trust the list above it.
- A `deny` line is zn protecting you, not an error. Its reason says why.
- To find out where a value went, read the host or command column of the line for that secret.

## See also

- [Audit](../audit.md): what the log and `zn audit` cover.
- [Secrets](../secrets.md): the vault and its files.
