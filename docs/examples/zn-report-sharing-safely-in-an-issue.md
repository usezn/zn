# Example: share a zn-gate report in an issue

You may want to paste the output of `zn-gate report` into an issue, a discussion or a message to a colleague. This page shows what the report contains, which parts of it are already hidden by zn-gate, and what to look at yourself before you paste. The command is described on the [report page](../report.md) and in the [command reference](../cli.md#report). All names, numbers and dates below are made up.

The report only reads files on your computer, writes nothing and opens no network connection, so running it is safe. Pasting it is your decision.

## 1. Run the report

```bash
npx -y zn-gate report
```

```text
zn-gate report: 2026-11-05 to 2026-11-11 (this computer only; nothing was sent)

  Blocked actions   : 10  (claude-code 7, cursor 3)
  Secrets hidden    : 15  (AWS_KEY 10, GITHUB_TOKEN 3, DB_PASSWORD 2)
  New MCP servers   : 1  (npx @example/notes-server@1.0.0)
  Tools changed, waiting for your approval: 1  (run: zn-gate pins)

  Busiest day: 2026-11-09 (5 blocked)

This report was built from files on your computer. Nothing left it.
Teams can see this for everyone in one place: usezn.com/team  (hide this line: zn-gate report --no-team-line)
```

The last line is an invitation to try zn Team. Leave it out of what you paste with `--no-team-line`.

## 2. What is already hidden

The report is built so that it never prints these things:

- **Your prompts and the content of your files.** It only reads counts.
- **Folder names and paths.** None appears in the output.
- **The names or values of your secrets.** `Secrets hidden` shows how many values were hidden and what kind they were (`AWS_KEY`, `GITHUB_TOKEN`, `DB_PASSWORD`), not what they were called.
- **The arguments of an MCP server.** A server is shown as its program and its package or script file, and nothing else. Say the example server was started as `npx -y @example/notes-server@1.0.0 --token <a made-up key>`. The report shows only `npx @example/notes-server@1.0.0`. A folder in front of a script file is dropped too, and a name that is not a plain program or package name is shown as `MCP server`.

You do not need to remove anything for these.

## 3. What to check yourself

Read the report once before you paste it. Three things can still say more than you want to share:

- **The name of an MCP server.** In the `New MCP servers` line, a package or script name can be private: the name of a package from your company, or of a project you work on. It is the one line that may name something that is not public. Delete the name, or the line, if you do not want to share it.
- **The agents, the counts and the dates.** `Blocked actions` names the agents you use, and the first line shows the period. They say little, but they say something about how you work.
- **What you paste around the report.** The command you typed and the text of the other commands are not made by the report, so they are not covered by the list above.

Do not paste the files the report reads from: `~/.zn/stats.json` and the files in `~/.zn/mcp-pins/`. The report is the safe summary of them. The pin files hold more: the full command line of each server, with detected secrets replaced.

## 4. Share fewer or other numbers

To share only the last few days, use `--since`. The period is from `1d` to `90d` and the default is `7d`:

```bash
npx -y zn-gate report --since 3d --no-team-line
```

An unknown option, or a period outside that range, prints `Usage: zn-gate report [--since 1d-90d] [--json] [--no-team-line]` and exits with `2`.

For a script, `--json` prints the same numbers:

```bash
npx -y zn-gate report --json
```

```json
{
  "since": "2026-11-05",
  "until": "2026-11-11",
  "days": 7,
  "blocked": 10,
  "redacted": 15,
  "by_agent": {
    "claude-code": 7,
    "cursor": 3
  },
  "secret_types": {
    "AWS_KEY": 10,
    "GITHUB_TOKEN": 3,
    "DB_PASSWORD": 2
  },
  "new_mcp_servers": [
    {
      "name": "npx @example/notes-server@1.0.0",
      "first_pinned_at": "2026-11-11T13:22:39.700Z"
    }
  ],
  "pending_tool_changes": 1,
  "busiest_day": {
    "day": "2026-11-09",
    "blocked": 5
  },
  "sources": [
    "stats.json",
    "mcp-pins"
  ],
  "sent": false
}
```

The JSON has the same content as the text, plus the exact time each new server was first seen. Apply the same check to it before you paste it: the `name` of each server is the part that can be private.

## 5. When there is nothing to show

On a computer where zn-gate has not checked anything yet, the report says so instead of showing numbers:

```text
zn-gate report: 2026-11-05 to 2026-11-11 (this computer only; nothing was sent)

  Nothing to report yet. zn-gate counts once it checks something (agent hooks, MCP tools or wrapped MCP servers).
```

If counting is turned off with `ZN_STATS=off`, the report says that its numbers may be incomplete. Say so when you share it.

## Related

- [See what zn-gate did this week](../report.md)
- [Example: stats and report](stats-and-report.md), for how to read each number.
- [Checklist: what to run and paste before asking for help](doctor-before-asking-for-help.md), for the other commands you may paste in an issue.
- [All examples](README.md)
