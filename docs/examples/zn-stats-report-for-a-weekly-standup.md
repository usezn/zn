# Example: three lines from `zn-gate report` for a weekly standup

A small script that turns the numbers of `zn-gate report` into three lines you can paste into a standup note or a chat. It uses only what zn-gate already counts on your computer, and it makes up no number. The numbers below come from a throwaway home folder that was fed a few made-up events, so they are example output. For what the report shows, read [See what zn-gate did this week](../report.md). For both commands in more detail, read [Stats and report](stats-and-report.md).

## Where the numbers come from

Both `report` and `stats` read counts kept on this computer. Nothing is sent. This page uses `report --json`, because its fields map to the three lines directly:

```bash
zn-gate report --since 7d --json
```

For the example, a throwaway home folder got eight made-up events: two reads of a `.env` file, one `cat .env`, three reads of an ordinary file, and two prompts that held a made-up AWS key. zn-gate stopped the five that touched the `.env` file or held the key. The text form of the report for those events:

```text
zn-gate report: 2026-11-05 to 2026-11-11 (this computer only; nothing was sent)

  Blocked actions   : 5  (claude-code 5)
  Secrets hidden    : 2  (AWS_KEY 2)
  New MCP servers   : 0  (only servers wrapped by zn-gate are listed)

  Busiest day: 2026-11-11 (5 blocked)

This report was built from files on your computer. Nothing left it.
```

And the same numbers with `--json`:

```json
{
  "since": "2026-11-05",
  "until": "2026-11-11",
  "days": 7,
  "blocked": 5,
  "redacted": 2,
  "by_agent": {
    "claude-code": 5
  },
  "secret_types": {
    "AWS_KEY": 2
  },
  "new_mcp_servers": [],
  "pending_tool_changes": 0,
  "busiest_day": {
    "day": "2026-11-11",
    "blocked": 5
  },
  "sources": [
    "stats.json",
    "mcp-pins"
  ],
  "sent": false
}
```

The fields:

| Field | The text line it matches |
| --- | --- |
| `blocked` and `by_agent` | `Blocked actions` |
| `redacted` and `secret_types` | `Secrets hidden` |
| `new_mcp_servers` | `New MCP servers`: a list of `name` and `first_pinned_at` |
| `pending_tool_changes` | `Tools changed, waiting for your approval` |
| `busiest_day` | `Busiest day`: `null` when nothing was blocked |

## The script

This script needs `jq`, a separate program that you install yourself.

```sh
#!/bin/sh
# Three lines for a standup, from the numbers zn-gate keeps on this computer.
zn-gate report --since 7d --json | jq -r '
  def list: to_entries | map("\(.key) \(.value)") | join(", ");
  def or_none: if . == "" then "none" else . end;
  "Blocked: \(.blocked) (\(.by_agent | list | or_none))",
  "Secrets hidden: \(.redacted) (\(.secret_types | list | or_none))",
  "MCP: \(.new_mcp_servers | length) new server(s), \(.pending_tool_changes) tool change(s) waiting for approval"
'
```

With the example numbers above, it prints:

```text
Blocked: 5 (claude-code 5)
Secrets hidden: 2 (AWS_KEY 2)
MCP: 0 new server(s), 0 tool change(s) waiting for approval
```

Those are the three lines. Change `--since 7d` for another period, from `1d` to `90d`. A value outside that range (`100d` was tried) is refused with exit code `2`.

## When nothing was counted

On a computer where zn-gate has checked nothing in the period, the JSON has zeros and empty lists, and the script prints:

```text
Blocked: 0 (none)
Secrets hidden: 0 (none)
MCP: 0 new server(s), 0 tool change(s) waiting for approval
```

This is also what you get with `ZN_STATS=off`, which turns counting off. Zeros do not tell you whether nothing happened or nothing was counted. To tell them apart, read the text form: `zn-gate report` says "Nothing to report yet" when it has counted nothing.

## One more number from `stats`

`stats` adds the number of events zn-gate checked, which is the total the blocks came from. With the same events:

```bash
zn-gate stats --days 7 --json | jq '.total.checked'
```

```text
8
```

`zn-gate stats --days 7` without `--json` prints the text form. It names the most frequent rule (here `AWS_KEY`) and gives a count for each agent. Only rule ids and counts are shown, never values, paths or command text. A fourth line for the standup could read: "Checked 8 events; most frequent rule: AWS_KEY". Use `--days` with `stats` (1 to 90) and `--since` with `report`.

## What stays out of the three lines

- The report shows kinds and counts, never a prompt, a file name or the name or value of a secret, so the three lines are safe to paste in a note that others read.
- Sharing counts with zn is a separate choice that is off unless you turn it on (`zn-gate stats share status` says whether it is). The report only reads files on your computer.
- A block tells you that zn-gate stopped something, not whether the agent was in the wrong. To see why the last block happened, run `zn why`.

## See also

- [Stats and report](stats-and-report.md): the text outputs, `--since` and `--no-team-line`.
- [See what zn-gate did this week](../report.md): what the report shows and where its data comes from.
- [Why blocked walkthrough](why-blocked-walkthrough.md): from a block to the `zn why` output.
