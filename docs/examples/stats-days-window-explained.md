# The stats window: what `--days` counts

`zn-gate stats` shows what zn-gate did on this computer over a number of days. `--days` sets that number, from 1 to 90, and the default is 30. This page shows which days a window covers, what the words `counting since` mean, and what happens with a value that is not allowed. For every option, see the [command line reference](../cli.md#stats); for a first run, see [Stats and report](stats-and-report.md).

The outputs below were printed on a test computer on 2026-11-08. Some earlier days of counts were added to its counts file by hand, so the windows differ from each other. The command itself was run for real. All numbers are examples.

Nothing is sent. `stats` reads the counts that zn-gate keeps on this computer.

## 1. The days in the test file

zn-gate keeps one set of counts for each day, and only the last 90 days. The test computer holds these days:

| Day | Blocked | Days before today |
| --- | --- | --- |
| 2026-11-08 | 1 | 0 (today) |
| 2026-11-07 | 4 | 1 |
| 2026-11-05 | 2 | 3 |
| 2026-11-02 | 1 | 6 |
| 2026-11-01 | 5 | 7 |
| 2026-10-19 | 4 | 20 |
| 2026-09-09 | 2 | 60 |

## 2. How a window is counted

`--days N` covers today and the `N - 1` days before it. Days are counted in UTC, so around midnight your local date and the UTC date can differ.

```bash
zn-gate stats --days 7
```

```text
zn-gate on this machine, last 7 days (counting since 2026-11-02):

  96 events checked (prompts, tool calls and tool results)
  8 blocked (a secret file read, a pasted secret, a prompt injection or a risky call)
  10 secret values replaced before the model saw them

  Secret types found: AWS_KEY 4, GITHUB_TOKEN 4, DB_PASSWORD 2

  By agent:
    claude-code (agent hooks): 84 events, 7 blocked, 10 replaced
    cursor (agent hooks): 12 events, 1 blocked, 0 replaced

  These counts stay on this machine. To help improve zn-gate, you can share pseudonymous daily counts:
  `zn-gate stats share show` shows exactly what would be sent, `zn-gate stats share on` turns it on.
```

The 7 days run from 2026-11-02 to 2026-11-08, so the table rows for 11-08, 11-07, 11-05 and 11-02 are in (1 + 4 + 2 + 1 = 8 blocked). The row for 2026-11-01 is 7 days before today, so it is just outside.

Compare the other windows on the same computer:

| Command | Days covered | Blocked | `counting since` |
| --- | --- | --- | --- |
| `zn-gate stats --days 1` | 2026-11-08 | 1 | 2026-11-08 |
| `zn-gate stats --days 7` | 2026-11-02 to 2026-11-08 | 8 | 2026-11-02 |
| `zn-gate stats` (30 days) | 2026-10-10 to 2026-11-08 | 17 | 2026-10-19 |
| `zn-gate stats --days 90` | 2026-08-11 to 2026-11-08 | 19 | 2026-09-09 |

The numbers in the table are the ones the four commands printed. A longer window adds older days to the same totals, so the counts only go up or stay the same.

## 3. What `counting since` means

The text in brackets after the title is not the first day of the window. It is the oldest day in the window that has counts. With the default 30-day window, the window starts on 2026-10-10, but the oldest day with counts is 2026-10-19, so the first line is:

```text
zn-gate on this machine, last 30 days (counting since 2026-10-19):
```

Read it as "there are no counts before this day". On a computer where zn-gate was installed recently, it shows the day it started counting, however long the window is. When there are no counts in the window at all, the part in brackets is left out:

```text
zn-gate on this machine, last 30 days:

  Nothing recorded yet. Counts start once zn-gate checks something (hooks, MCP tools or wrapped servers).
```

## 4. The window in JSON

`--json` prints the same counts as one JSON object. The field `days` is the window you asked for and `since` is the oldest day with counts, as in the text:

```bash
zn-gate stats --days 7 --json
```

```json
{
  "days": 7,
  "since": "2026-11-02",
  "total": {
    "checked": 96,
    "blocked": 8,
    "warned": 0,
    "redacted": 10
  },
  "byKey": {
    "hook:claude-code": {
      "checked": 84,
      "blocked": 7,
      "warned": 0,
      "redacted": 10
    },
    "hook:cursor": {
      "checked": 12,
      "blocked": 1,
      "warned": 0,
      "redacted": 0
    }
  },
  "detections": {
    "AWS_KEY": 4,
    "DB_PASSWORD": 2,
    "GITHUB_TOKEN": 4
  },
  "events": {},
  "sharing": false,
  "sent_days": [],
  "send_failed": 0
}
```

`sharing`, `sent_days` and `send_failed` are about the optional sharing of counts and are explained in the [command line reference](../cli.md#stats).

## 5. Values that are refused

`--days` must be a whole number from 1 to 90. Anything else prints the usage and exits with code `2`. This is what `--days 0`, `--days 91` and `--days abc` printed:

```text
Usage: zn-gate stats [--days 1-90] [--json]
       zn-gate stats share on|off|status|show
```

Ninety days is also how long zn-gate keeps counts, so a longer window could not show more.

## 6. The report uses another option

`zn-gate report` shows a similar summary but names its window `--since`, in the form `7d`, and its default is 7 days, not 30. See [Report](../report.md) for what it shows.

## What to check

- You asked for the window you meant: `last N days` in the first line must match your `--days`.
- If the totals look too small, check `counting since`: zn-gate may only have started counting recently.
- A number that is the same for `--days 30` and `--days 90` means there are no counts older than 30 days.

## See also

- [Stats and report](stats-and-report.md): the first run, with `report` and sharing.
- [Report](../report.md): the weekly summary and its `--since` option.
- [Command line reference](../cli.md#stats): every option and exit code.
