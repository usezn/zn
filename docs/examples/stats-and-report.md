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

  Secret types found: AWS_KEY 14, DB_PASSWORD 8, GITHUB_TOKEN 6, JWT 3, EMAIL 2

  Top rules, last 7 days:
    AWS_KEY  Built-in detector  9
    DB_PASSWORD  Built-in detector  4
    GITHUB_TOKEN  Built-in detector  4
    JWT  Built-in detector  3
    EMAIL  Built-in detector  2
  Most frequent: AWS_KEY. To understand your last block, run: zn why
```

The `Top rules` block covers 7 days by default. `zn-gate stats --days 30` makes it cover 30 days. It shows only detector ids, the generic label `Built-in detector` and counts, never values, paths or command text. With `--json`, the same list is in `top_rules`. The hint line above is the npm package's; the Python package points to the troubleshooting page instead.

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

## Reading the daily counts

`zn-gate stats` adds up the counts of the window (30 days by default, or `--days`). It does not print one line per day. The daily counts are in `stats.json`, in your zn folder (`~/.zn`, or the folder that `ZN_HOME` names). This is how one day looks, from the code that writes the file (the numbers are made up):

```json
{
  "version": 1,
  "days": {
    "2026-11-10": {
      "mcp:cursor": {
        "checked": 5,
        "blocked": 0,
        "warned": 1,
        "redacted": 1,
        "detections": { "GITHUB_TOKEN": 1, "OTHER": 2 }
      }
    }
  },
  "events": {}
}
```

Each day key is a UTC date (`YYYY-MM-DD`). Inside a day, there is one entry per layer and agent, named `layer:agent`:

- `layer` is where zn-gate checked: `hook` (agent hooks), `shield` (wrapped MCP servers), `mcp` (MCP tools), `broker` (secrets broker) or `cli` (command line).
- `agent` is the name of the coding agent, in lower case (at most 32 characters; otherwise it is `other`).

The fields of each entry:

- `checked`: the events zn-gate looked at: prompts, tool calls and tool results.
- `blocked`: the times zn-gate stopped something: a secret file read, a pasted secret, a prompt injection or a risky call.
- `warned`: the warnings. The text output prints this line only when the count is above 0.
- `redacted`: the secret values replaced before the model saw them.
- `detections`: how many values of each secret type were found, for example `AWS_KEY` or `DB_PASSWORD`. Only built-in types are kept. A value matched by a variable name that starts with `ENV_` is counted as `ENV_VALUE`, and any other name becomes `OTHER`, so no name you chose is stored. `redacted` and `detections` are recorded separately, so their totals need not be equal.

The counts are approximate: two programs that write at the same moment can lose one increment.

### What the command adds up

For `--days 7`, the window is today and the six days before it. The header gives the first day that has data in the window (`counting since`). The text output for the same counts looks like this:

```text
zn-gate on this machine, last 7 days (counting since 2026-11-08):

  62 events checked (prompts, tool calls and tool results)
  6 blocked (a secret file read, a pasted secret, a prompt injection or a risky call)
  3 secret values replaced before the model saw them
  1 warnings

  Secret types found: AWS_KEY 2, OTHER 2, DB_PASSWORD 1, ENV_VALUE 1, GITHUB_TOKEN 1

  Top rules, last 7 days:
    AWS_KEY  Built-in detector  2
    OTHER  Built-in detector  2
    DB_PASSWORD  Built-in detector  1
    ENV_VALUE  Built-in detector  1
    GITHUB_TOKEN  Built-in detector  1
  Most frequent: AWS_KEY. To understand your last block, run: zn why

  By agent:
    claude-code (agent hooks): 50 events, 4 blocked, 2 replaced
    cursor (shield (wrapped MCP servers)): 7 events, 2 blocked, 0 replaced
    cursor (MCP tools): 5 events, 0 blocked, 1 replaced
```

Read the totals at the top as sums of the daily entries inside the window. `By agent` sums each `layer:agent` key over the window, so the same agent can show up once per layer. The `Top rules` block sums `detections` over the window and lists the five largest. `OTHER` is a bucket for names that are not built-in types, so it is not a single rule.

The `--json` output has the same sums, not the days: `total`, `byKey` (per `layer:agent`), `detections`, `events`, and the `top_rules` fields described in the [command line reference](../cli.md#stats). To see a single day, read `stats.json`.

A few rules that the code applies when it counts or prints:

- The window must be 1 to 90 days. `--days 0` and `--days 91` print the usage line and exit with code `2`.
- A day that is more than one day ahead of today (a wrong clock) is left out of the output and of the totals.
- Days older than 90 days are removed when zn-gate next writes a count, unless the clock looks wrong.
- With `ZN_STATS=off`, zn-gate writes no new counts, and `stats` says that counting is off on this machine.

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
