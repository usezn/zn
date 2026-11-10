# Example: reading a vault log

A short walk-through of the output of [`zn-gate vault log`](../cli.md#vault-log), the local audit log of secret use. `zn-gate secret log` shows the same output. For every option, read the [CLI page](../cli.md#vault-log) and the [secrets page](../secrets.md).

The lines below are an illustration, not a real run. The secret name `DEMO_TOKEN` and the host `api.example.com` are made up. The layout is the one the code prints, field by field.

The log never holds a secret value. Each record keeps only metadata: when it happened, which secret name was used, how, by which agent and tool, and why.

## Run it

```bash
npx -y zn-gate vault log --since 1h
```

`--since` takes a number with `s`, `m`, `h` or `d`, such as `30m` or `2d`, or a date. Without it, the whole log is shown. The records are listed oldest first, and the chain line comes last.

## The sample

```text
2026-11-10T09:12:40.530Z  deny  DEMO_TOKEN  env  claude-code  Bash  node  declined_by_user
2026-11-10T09:15:03.007Z  deny  DEMO_TOKEN  proxy  claude-code  mcp:secrets_http_request  api.example.com  policy:org_deny
chain: valid, 2 records
```

## Each line is one record

Every record is one line with eight fields, separated by two spaces:

| # | Field | What it holds |
|---|---|---|
| 1 | time | When the record was written, in UTC with milliseconds (the `Z` at the end means UTC). This command does not convert it to your local time. |
| 2 | decision | What zn decided. `allow` lets the use through and `deny` blocks it. `warn` lets it through with a warning. `ask`, `ask:yes` and `ask:no` mean the user was asked and what the answer was. `restore`, `withhold` and `error` are results written by zn's own steps. Any other value is stored as `other`. |
| 3 | secret | The name of the secret: capital letters, digits and `_`, up to 80 characters. Never the value. |
| 4 | mode | How the secret was used. `proxy` is a secret stored for HTTP requests, `env` a secret stored for a program, and `file` a secret stored for a file (see the [secrets page](../secrets.md)). `named`, `detected` and `resolve` are other ways a secret was used or found, `set` and `remove` are changes to a secret, and `unlock`, `lock` and `expire` are the vault's own steps. Any other value is stored as `other`. |
| 5 | agent | The agent that asked, such as `claude-code`. |
| 6 | tool | The tool the agent used, such as `Bash`, or an MCP tool name such as `mcp:secrets_http_request`. |
| 7 | program or host | For a program, its file name without the folder (`node`). For a network request, the host (`api.example.com`). Blank when the record has neither. |
| 8 | reason | A short code for why, such as `declined_by_user` or `policy:org_deny`. Blank when the record has none. |

Two rules show up in the output:

- A field the record does not have is shown as `-`. This applies to the secret, mode, agent, tool and decision columns. The program or host column and the reason column are left blank instead, so a line can end with two spaces.
- A value that does not match its format is shown as `[invalid]`. A field that holds a known secret value is shown as `[redacted]`. Either one means the record was changed before it was written, so do not expect the original text.

## The chain line

The last line checks the log. Each record is signed and linked to the one before it, so a changed, removed or reordered record shows up. The chain line says one of three things:

- `chain: valid, N records`: the whole log was checked and all N records are correct. The command exits with `0`.
- `chain: not checked: the vault is locked or unreachable`: the vault is locked, so the signatures could not be checked. Run `zn-gate unlock`, then `zn-gate vault verify`. The records are still listed, and the command exits with `0`.
- `chain: BROKEN: ...`: the check failed, and the command exits with `1`. Keep a copy of the audit log file as evidence (`~/.zn/audit.jsonl`), and run `zn-gate vault verify`. If the vault is unlocked and finds the problem before it reads the records, it does not show the records at all.

If the vault is unlocked but could not run the check, the command shows no records, says why, and exits with `1`.

## What to look for

- A `deny` or `allow` line for a secret you did not expect to be used. The name and the host or program tell you where it went.
- A `chain: BROKEN` line. Do not delete or edit the file. Keep a copy, then follow [vault verify](../cli.md#vault-verify).
- `--since` to narrow a long log, for example `zn-gate vault log --since 1h` to see only the last hour.
