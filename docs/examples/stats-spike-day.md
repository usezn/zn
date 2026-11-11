# Example: find a spike day in zn-gate stats

A walk through finding one busy day in your local counts. `zn-gate stats` shows totals for a window of days, not a line per day, so the day is found in steps. The numbers below come from a real run of zn-gate on a test machine, with a `stats.json` of made-up counts. Your numbers will differ.

Everything here reads counts kept on your computer. Nothing is sent.

## What the command shows

`zn-gate stats --days N` prints one total for the last N days, today included. `--days 1` is today only. The output has no line per day, and `--json` has the same totals. Its `days` field is the window length (`7` for `--days 7`), not a list of days.

The per-day counts are in the stats file: `~/.zn/stats.json`, or `$ZN_HOME/stats.json` when `ZN_HOME` is set. Days are keys in UTC, so "today" is the UTC date. On Windows the file is `%USERPROFILE%\.zn\stats.json`.

## Step 1: compare a short window with a long one

```bash
zn-gate stats --days 1
zn-gate stats --days 7
```

```text
zn-gate on this machine, last 1 day (counting since 2026-11-11):

  4 events checked (prompts, tool calls and tool results)
  0 blocked (a secret file read, a pasted secret, a prompt injection or a risky call)
```

```text
zn-gate on this machine, last 7 days (counting since 2026-11-05):

  108 events checked (prompts, tool calls and tool results)
  10 blocked (a secret file read, a pasted secret, a prompt injection or a risky call)
```

Today is quiet and the week is not. That tells you a busy day is inside the week, but not which day. The window can also miss it: here the busy day was three days ago, so `--days 1` does not show it.

## Step 2: find the day by subtracting windows

Each window contains the days of the shorter window before it. So the total of `--days N` minus the total of `--days N-1` is the total of the one day that is N-1 days before today:

```bash
zn-gate stats --days 3 --json | jq .total.checked
zn-gate stats --days 4 --json | jq .total.checked
```

```text
17
78
```

78 - 17 = 61 events. The day that is 3 days before today (the fourth day of the `--days 4` window) is the busy one, here 2026-11-08. The same subtraction works on the `events checked` line of the text output if you do not have `jq`.

This gives totals only. For the agents on that day, go to step 3.

## Step 3: read the per-day map

```bash
jq -r '.days | to_entries[] | "\(.key) \([.value[].checked] | add)"' "${ZN_HOME:-$HOME/.zn}/stats.json" | sort -k2 -n | tail -3
```

```text
2026-11-06 10
2026-11-05 11
2026-11-08 61
```

The last line is the busiest day. Each day's entry is keyed by `<layer>:<agent>`, for example `hook:claude-code` or `mcp:cursor`, each with its own `checked`, `blocked`, `warned`, `redacted` and `detections`. Print one day to see which agent made the calls:

```bash
jq '.days["2026-11-08"]' "${ZN_HOME:-$HOME/.zn}/stats.json"
```

```text
{
  "hook:claude-code": { "checked": 58, "blocked": 9, "warned": 0, "redacted": 12, "detections": { "AWS_KEY": 12 } },
  "mcp:cursor": { "checked": 3, "blocked": 1, "warned": 0, "redacted": 0, "detections": { "DB_PASSWORD": 1 } }
}
```

Without `jq`, open the file in a text editor: the keys of `days` are the dates.

## What the counts cannot tell you

- Why the day was busy. The counts hold no values, prompts, paths or file names. For the blocks themselves, `zn why` explains the last block, and `zn evidence --export` lists the records that the evidence log keeps.
- An exact count. Two agents writing at the same moment can lose an increment, so the counts are approximate.
- Days older than 90 days. zn-gate removes them, and `--days` accepts at most 90.
- Days when counting was off. With `ZN_STATS=off` nothing is counted, so those days have no entries.

## See also

- [Command line reference](../cli.md#stats): all options of `stats`.
- [Report](../report.md): the weekly summary built from the same counts.
- [Stats and report examples](stats-and-report.md): more outputs of `stats` and `report`.
