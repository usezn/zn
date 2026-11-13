# Example: reading a reach history report

A short walk-through of the output of [`zn-gate reach --history`](../reach.md#history-did-your-agents-keep-a-secret-of-yours). It reads the local session histories of your coding agents and tells you which kinds of secret they hold. For every flag and limit, read the [full page](../reach.md).

The output below is real. It comes from a run of the command against a throwaway home folder that holds three small history files, written for this page. The files contain two fake keys: the AWS key from the AWS documentation (`AKIA` followed by `IOSFODNN7EXAMPLE`) and a GitHub-style token of the form `ghp_` followed by letters and digits. A real report lists your own files.

## Run it

```bash
npx -y zn-gate reach --history
```

The command is read only. It needs no account or API key, sends nothing and changes nothing. The report never shows a secret value, not even a part of one.

## The report

```text
zn-gate reach --history: did your coding agents keep a secret of yours in their session history?
Read: the local history files of your agents. Nothing was sent anywhere, nothing was changed, and no value is shown.

  Claude Code  2 files, 0.0 MB scanned
  Codex CLI    1 file, 0.0 MB scanned
  Cursor       not scanned: its history is a database, which this version does not read
  OpenCode     not scanned: its history is a database, which this version does not read
  Gemini CLI   not scanned yet: this version does not read its history
  Copilot      not scanned yet: this version does not read its history
  Antigravity  not scanned yet: this version does not read its history
  ZCode        not scanned yet: this version does not read its history

CLAUDE CODE
  ~/.claude/projects/demo-app/session-1.jsonl
    2 x GITHUB_TOKEN
    Do this: Rotate this GitHub token in your GitHub settings, then delete this session file if you do not need it.
  ~/.claude/projects/demo-app/session-1.jsonl
    1 x AWS_KEY
    Do this: Rotate this AWS access key in the AWS console (IAM), then delete this session file if you do not need it.
CODEX CLI
  ~/.codex/sessions/2026/11/rollout-1.jsonl
    1 x AWS_KEY
    Do this: Rotate this AWS access key in the AWS console (IAM), then delete this session file if you do not need it.

4 secrets in 2 files.

A key listed here may already be rotated. Check before you rotate.
zn-gate cannot see what was already sent to your model provider.
```

## Section by section

### The agent list

Every agent zn-gate knows has a line, so you can see what was and was not read.

- `2 files, 0.0 MB scanned`: the agent has a history folder. This is how many history files were read and how much data they held. The size is in megabytes with one decimal, so small histories show `0.0 MB`.
- `no history found`: the agent has no history folder on this machine.
- `not scanned: its history is a database`: Cursor and OpenCode keep their history in a database, which this version does not read.
- `not scanned yet`: Gemini CLI, Copilot, Antigravity and ZCode are supported by zn-gate, but this version does not read their history.

An empty result is therefore not proof that nothing leaked. Only the agents with a file count were checked.

### The findings

Findings are grouped by agent. Each finding has three parts:

- the history file, with your home folder shown as `~`;
- a count and a secret type, such as `2 x GITHUB_TOKEN`: this file holds two matches of that type. The two matches may be the same secret pasted twice, as in the example, so the count is a number of matches, not of distinct secrets;
- a `Do this` line: the step to take for that type. It is fixed text, never taken from your file.

A file with more than one type appears once per type, as `session-1.jsonl` does above. Within an agent, the findings with the most matches come first.

The line `4 secrets in 2 files.` adds the counts up across all agents. Here 2 + 1 + 1 matches are spread over two files.

### What to do with a finding

1. Rotate the secret where it was issued. Deleting the session file is not enough, because the key may be in other places and may have been used already.
2. Delete the session file if you do not need it. Once the secret is rotated the file holds a dead key, but deleting it removes the copy.

The last two lines say two things: a listed key may already be rotated, so check before you rotate, and zn-gate cannot see what was already sent to your model provider.

## When some files are not fully scanned

If a file cannot be read in full, the report adds a `NOT FULLY SCANNED` section, and a clean result is worded as `Nothing found in what was scanned. Some files were not fully scanned (below).` The reasons are:

| Reason shown | Meaning |
|---|---|
| `not scanned: it is a link, and links are never followed` | The file or folder is a link. |
| `not scanned: it could not be read` | The file could not be opened. |
| `partly scanned: a line was too long to read` | One line was too long to read. |
| `not scanned: it is nested too deep` | The folder is nested more than 6 levels below the history folder. |
| `not scanned: there are too many history files` | More than 50000 history files for one agent. |
| `not fully scanned: the time limit was reached` | The scan hit the time limit. |

The time limit is 120 seconds by default. When it is reached, the report ends the section with `Run again with a larger --max-seconds to scan them (now 120).` Raise it with a whole number from 1 to 3600:

```bash
npx -y zn-gate reach --history --max-seconds 600
```

## Use it in a script

Add `--json` for output a script can read:

```bash
npx -y zn-gate reach --history --json
```

The JSON has the same facts as the text: `agents`, `findings` (each with `agent`, `file`, `type`, `count` and `action`), `incomplete`, `totals` (`files_scanned`, `bytes_scanned`, `files_with_secrets`, `secrets`, `files_not_reached`), `time_limit_hit`, `max_seconds` and `notes`. In the run above `totals` was 3 files scanned, 2 files with secrets and 4 secrets.

The command exits 0 whether or not it finds secrets, so it is a report, not a gate. It exits 2 for a usage error, such as combining `--history` with a folder, `--sarif`, `--fail-on` or `--remember`, or when the scan fails. For the full JSON fields, see the [reach page](../reach.md#history-did-your-agents-keep-a-secret-of-yours).

## More

- [The reach page](../reach.md)
- [All examples](README.md)
