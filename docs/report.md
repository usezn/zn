# See what zn-gate did this week

```bash
npx -y zn-gate report
```

(or `zn-gate report` if you installed it with `npm i -g zn-gate`).

## What it shows

A short summary of the last 7 days on this computer:

- **Blocked actions**: how many times zn-gate stopped something, and for which agent.
- **Secrets hidden**: how many secret values were replaced before your agent saw them, and what kind they were. The kind is the detector's own type name (for example `AWS_KEY`, `DB_PASSWORD` or `GITHUB_TOKEN`), not the name of your variable or secret: zn-gate stores only its built-in types and counts anything else as `OTHER`.
- **New MCP servers**: servers that zn-gate started protecting during the period.
- **Tools changed, waiting for your approval**: tools of a protected MCP server that changed since you last approved them. Review them with `zn-gate pins`.
- **Busiest day**: the day with the most blocked actions.

```text
zn-gate report: 2026-10-11 to 2026-10-17 (this computer only; nothing was sent)

  Blocked actions   : 12  (claude-code 9, cursor 3)
  Secrets hidden    : 31  (AWS_KEY 14, DB_PASSWORD 8, GITHUB_TOKEN 6)
  New MCP servers   : 1  (npx @modelcontextprotocol/server-github)
  Tools changed, waiting for your approval: 1  (run: zn-gate pins)

  Busiest day: 2026-10-14 (9 blocked)

This report was built from files on your computer. Nothing left it.
```

If zn-gate has not checked anything yet, it says so and shows no numbers. Counts start once zn-gate checks something (agent hooks, MCP tools or protected MCP servers). If counting is turned off with `ZN_STATS=off`, the report says that too.

## Options

| Option | What it does |
|---|---|
| `--since 30d` | Use another period, from `1d` to `90d`. The default is `7d`. |
| `--json` | Print the same numbers as JSON, for scripts. |
| `--no-team-line` | Leave out the closing line about zn Team. The line also does not appear once this computer has joined a Team. |

### Options at a glance

| Option | Default | Example |
|---|---|---|
| `--since <period>` | `7d` (allowed: `1d` to `90d`) | `zn-gate report --since 30d` |
| `--json` | Off (prints the text summary) | `zn-gate report --json` |
| `--no-team-line` | Off (the closing line about zn Team is shown, unless this computer has joined a Team) | `zn-gate report --no-team-line` |

## Example: save the report to a file and read it later

`zn-gate report` has no option to write a file; it prints the summary. To keep a copy, send the output to a file with your shell, then open that file whenever you want:

```bash
# Save this week's summary, without the closing line about zn Team
zn-gate report --no-team-line > zn-report-week.txt

# Later: read the saved copy
cat zn-report-week.txt
```

The saved file holds the same text the command printed, for example:

```text
zn-gate report: 2026-10-11 to 2026-10-17 (this computer only; nothing was sent)

  Blocked actions   : 12  (claude-code 9, cursor 3)
  Secrets hidden    : 31  (AWS_KEY 14, DB_PASSWORD 8, GITHUB_TOKEN 6)
  New MCP servers   : 1  (npx @modelcontextprotocol/server-github)
  Tools changed, waiting for your approval: 1  (run: zn-gate pins)

  Busiest day: 2026-10-14 (9 blocked)

This report was built from files on your computer. Nothing left it.
```

For a script, save the JSON form for a longer period instead:

```bash
zn-gate report --since 30d --json > zn-report-30d.json
```

The file is written by your shell, not by zn-gate, so it stays wherever you saved it. It contains only what the report prints: counts, kinds of secrets and server names, never secret values.

## Your data stays here

The report only reads two things that zn-gate already keeps on your computer: the counts in `~/.zn/stats.json` and the list of protected MCP servers. It writes no files, opens no network connection and needs no account. It never prints prompts, file contents, folder names or the names of your secrets (the kinds in brackets are zn-gate's built-in detector types); a server is shown only by its name (the program and the package or script file), never by its arguments.

Sharing counts with zn is a separate choice that is off unless you turn it on (`zn-gate stats share status`).

## Next steps

- [CLI reference](cli.md): see every command and option, including the ones that read the same counts.
- [Stats and report example](examples/stats-and-report.md): follow a full run and see what the output means.
- [Recipes](recipes.md): copy short answers for common tasks.
- [`report` in the CLI reference](cli.md#report): the command syntax, its options and its exit codes (`0` done, `2` wrong usage).
