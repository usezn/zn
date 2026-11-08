# Reading a stats report

`zn-gate report` prints a short summary of what zn-gate did on your computer. This page goes through it line by line, shows what changes when the period changes, and shows the same numbers as JSON. For the options and exit codes, see the [command line reference](../cli.md#report); for a first run, see [Stats and report](stats-and-report.md).

The outputs below were printed on a test computer. A few earlier days of counts were added to its counts file by hand, so that every line has something to show. The command itself was run for real. All names, numbers and dates are examples.

The report reads only files on your computer. Nothing is sent.

## 1. Run it

```bash
zn-gate report
```

```text
zn-gate report: 2026-11-02 to 2026-11-08 (this computer only; nothing was sent)

  Blocked actions   : 8  (claude-code 7, cursor 1)
  Secrets hidden    : 10  (AWS_KEY 4, GITHUB_TOKEN 4, DB_PASSWORD 2)
  New MCP servers   : 1  (npx @modelcontextprotocol/server-github)
  Tools changed, waiting for your approval: 1  (run: zn-gate pins)

  Busiest day: 2026-11-07 (4 blocked)

This report was built from files on your computer. Nothing left it.
Teams can see this for everyone in one place: usezn.com/team  (hide this line: zn-gate report --no-team-line)
```

If `zn-gate` is not on your PATH, the hints that zn-gate prints may start with `npx -y zn-gate@<version>`. This page shows `zn-gate` instead.

## 2. Read each part

| Part | What it tells you |
| --- | --- |
| First line | The period: first day to last day, both included, and a reminder that nothing was sent. |
| `Blocked actions` | How many times zn-gate stopped something in the period, and in which agents. Up to five agents are listed, the biggest first. |
| `Secrets hidden` | How many secret values were replaced before the model saw them, and their kinds. Only the kind is shown (`AWS_KEY`), never a name or a value. Up to five kinds are listed. A value hidden without a known kind counts as `OTHER`. |
| `New MCP servers` | MCP servers that zn-gate began protecting during the period. A server is shown by its program and its package or script (`npx @modelcontextprotocol/server-github`), never by its arguments. With none, the line says `0  (only servers wrapped by zn-gate are listed)`. |
| `Tools changed, waiting for your approval` | Tools of a protected MCP server that changed since you last approved them. This line only appears when the number is more than zero. Review them with `zn-gate pins`. |
| `Busiest day` | The day with the most blocked actions. This line only appears when something was blocked. |
| Last lines | A reminder that the report was built from local files. The line about Teams can be hidden with `--no-team-line`. |

Days are counted in UTC, so the last day of a report can differ from your local date for a few hours.

## 3. Change the period

The default period is 7 days: today and the 6 days before it. Use `--since` for another one, from `1d` to `90d`:

```bash
zn-gate report --since 30d
```

```text
zn-gate report: 2026-10-10 to 2026-11-08 (this computer only; nothing was sent)

  Blocked actions   : 17  (claude-code 12, cursor 5)
  Secrets hidden    : 12  (AWS_KEY 4, DB_PASSWORD 4, GITHUB_TOKEN 4)
  New MCP servers   : 1  (npx @modelcontextprotocol/server-github)
  Tools changed, waiting for your approval: 1  (run: zn-gate pins)

  Busiest day: 2026-11-01 (5 blocked)

This report was built from files on your computer. Nothing left it.
Teams can see this for everyone in one place: usezn.com/team  (hide this line: zn-gate report --no-team-line)
```

A longer period adds the older days, so the numbers go up and the busiest day can move: here it is 2026-11-01, a day that the 7-day report did not include.

With `--since 1d`, only today is counted:

```bash
zn-gate report --since 1d
```

```text
zn-gate report: 2026-11-08 to 2026-11-08 (this computer only; nothing was sent)

  Blocked actions   : 1  (claude-code 1)
  Secrets hidden    : 0
  New MCP servers   : 0  (only servers wrapped by zn-gate are listed)
  Tools changed, waiting for your approval: 1  (run: zn-gate pins)

  Busiest day: 2026-11-08 (1 blocked)

This report was built from files on your computer. Nothing left it.
Teams can see this for everyone in one place: usezn.com/team  (hide this line: zn-gate report --no-team-line)
```

Notice that the tool change is still listed, although the MCP server was added two days ago and is no longer under `New MCP servers`. That line is not limited to the period: it shows what is waiting for you right now.

A period outside 1 to 90 days is refused with the usage line and exit code `2`:

```bash
zn-gate report --since 120d
```

```text
Usage: zn-gate report [--since 1d-90d] [--json] [--no-team-line]
```

## 4. The same numbers as JSON

```bash
zn-gate report --json
```

```json
{
  "since": "2026-11-02",
  "until": "2026-11-08",
  "days": 7,
  "blocked": 8,
  "redacted": 10,
  "by_agent": {
    "claude-code": 7,
    "cursor": 1
  },
  "secret_types": {
    "AWS_KEY": 4,
    "DB_PASSWORD": 2,
    "GITHUB_TOKEN": 4
  },
  "new_mcp_servers": [
    {
      "name": "npx @modelcontextprotocol/server-github",
      "first_pinned_at": "2026-11-06T12:45:03.639Z"
    }
  ],
  "pending_tool_changes": 1,
  "busiest_day": {
    "day": "2026-11-07",
    "blocked": 4
  },
  "sources": [
    "stats.json",
    "mcp-pins"
  ],
  "sent": false
}
```

The fields match the text lines: `blocked` and `by_agent` are the blocked actions, `redacted` and `secret_types` are the hidden secrets, `new_mcp_servers` and `pending_tool_changes` are the MCP lines. The JSON lists every agent and every kind, not only the top five. `sources` names the two local sources the report read, and `sent` is always `false`.

## 5. When there is nothing to show

On a computer where zn-gate has not checked anything yet:

```text
zn-gate report: 2026-11-02 to 2026-11-08 (this computer only; nothing was sent)

  Nothing to report yet. zn-gate counts once it checks something (agent hooks, MCP tools or wrapped MCP servers).

Teams can see this for everyone in one place: usezn.com/team  (hide this line: zn-gate report --no-team-line)
```

If counting is turned off with `ZN_STATS=off`, the report adds this line before the closing text:

```text
Counting is off on this computer (ZN_STATS=off), so these numbers may be incomplete.
```

## What to check

- The first line shows the period you meant. For a different one, use `--since`.
- A high `Blocked actions` count is not an alarm by itself. Each block is a decision you can read in the [decision log](evidence-example.md) and explain with `zn-gate why` ([why was this blocked](../why-was-this-blocked.md)).
- `Tools changed, waiting for your approval` is more than zero: review it with `zn-gate pins`, and approve only changes you expected.
- `Secrets hidden` shows kinds, never values. If a kind surprises you, look for where that secret is used.

## See also

- [Report](../report.md): what the report shows and where its data comes from.
- [Stats and report](stats-and-report.md): the shorter walk-through, with `stats` and sharing.
- [Command line reference](../cli.md#report): every option and exit code.
