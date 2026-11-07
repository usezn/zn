# Examples: stats and report

Worked examples of `zn-gate stats` and `zn-gate report`. All numbers, names and dates below are made up. For every option and exit code, see the [command line reference](../cli.md#stats) and the [report page](../report.md).

Both commands read only counts kept on your computer. Nothing is sent.

## Outputs at a glance

| Output | Flag or setting | Section |
| --- | --- | --- |
| Weekly report | none (default period is 7 days) | [Weekly report](#weekly-report) |
| Longer period | `--since 30d` | [A longer period](#a-longer-period) |
| JSON | `--json` | [JSON for scripts](#json-for-scripts) |
| Most frequent detectors | `zn-gate stats` | [Top rules in stats](#top-rules-in-stats) |
| No closing line | `--no-team-line` | [Leave out the closing line](#leave-out-the-closing-line) |
| Nothing to show | none; counting off with `ZN_STATS=off` | [When there is nothing to show](#when-there-is-nothing-to-show) |

## Weekly report

```bash
zn-gate report
```

```text
zn-gate report: 2026-10-11 to 2026-10-17 (this computer only; nothing was sent)

  Blocked actions   : 12  (claude-code 9, cursor 3)
  Secrets hidden    : 31  (AWS_KEY 14, DB_PASSWORD 8, GITHUB_TOKEN 6)
  New MCP servers   : 1  (npx @modelcontextprotocol/server-github)
  Tools changed, waiting for your approval: 1  (run: zn-gate pins)

  Busiest day: 2026-10-14 (9 blocked)

This report was built from files on your computer. Nothing left it.
```

How to read it:

- `Blocked actions` counts the times zn-gate stopped something, per agent.
- `Secrets hidden` counts secret values replaced before the agent saw them, by kind. Only the kind is shown, never the name or value.
- `New MCP servers` shows a server by its program and package or script name, never by its arguments.
- `Tools changed, waiting for your approval` points to `zn-gate pins`, where you review the changes.

## Top rules in stats

```bash
zn-gate stats
```

```text
zn-gate on this machine, last 30 days (counting since 2026-10-02):

  412 events checked (prompts, tool calls and tool results)
  12 blocked (a secret file read, a pasted secret, a prompt injection or a risky call)
  31 secret values replaced before the model saw them

  Secret types found: AWS_KEY 14, DB_PASSWORD 8, GITHUB_TOKEN 6, JWT 3

  Top rules, last 7 days:
    AWS_KEY  Built-in detector  9
    DB_PASSWORD  Built-in detector  4
    GITHUB_TOKEN  Built-in detector  4
    JWT  Built-in detector  3
    EMAIL  Built-in detector  2
  Most frequent: AWS_KEY. To understand your last block, run: zn why
```

The `Top rules` block covers 7 days by default. `zn-gate stats --days 30` makes it cover 30 days. It shows only detector ids and counts, never values, paths or command text. With `--json`, the same list is in `top_rules`.

## A longer period

The default period is 7 days. Use `--since` for another one, from `1d` to `90d`:

```bash
zn-gate report --since 30d
```

## JSON for scripts

```bash
zn-gate report --since 30d --json
```

This prints the same numbers as JSON. Use it in a script instead of reading the text.

## Leave out the closing line

```bash
zn-gate report --no-team-line
```

Leaves out the closing line about zn Team.

## When there is nothing to show

If zn-gate has not checked anything yet, the report says so and shows no numbers. Counts start once zn-gate checks something (agent hooks, MCP tools or protected MCP servers). If counting is turned off, the report says that too:

```bash
ZN_STATS=off zn-gate report
```

## Local counts with stats

```bash
zn-gate stats
zn-gate stats --days 7
zn-gate stats --days 90 --json
```

`stats` shows what zn-gate did on this machine. The default period is 30 days; `--days` accepts 1 to 90. `--json` prints the counts as JSON. An option it does not accept exits with code `2`.

## Check whether sharing is on

Sharing counts with zn is off unless you turn it on. To see the state:

```bash
zn-gate stats share status
```

To see what would be shared:

```bash
zn-gate stats share show
```

Turning sharing on (`stats share on`) is something only you can do, in your own terminal, and it asks you to confirm first. Turn it off again with `zn-gate stats share off`.

## See also

- [Report](../report.md): what the report shows and where its data comes from.
- [Command line reference](../cli.md): all commands, options and exit codes.
