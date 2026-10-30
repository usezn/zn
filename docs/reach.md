# zn-gate reach

`zn-gate reach` shows, on one screen, what the coding agents on your machine
can reach: which agents are installed and whether zn protects them, which
secrets sit in the `.env` files of the folder you are in, which credential
files exist in your home folder, which MCP servers the agents are set up to
run, and what the project and your agent settings make an agent load or run.
Every finding comes with the command that fixes it.

```bash
npx -y zn-gate reach            # the folder you are in
npx -y zn-gate reach ./my-app   # another folder
```

It is read only. It changes no file, starts no hook, opens no network
connection and sends nothing anywhere. It needs no account and no API key.

## What it shows

The report has these sections, in this order. Sections with nothing to report
are left out.

| Section | What it means |
| --- | --- |
| `AGENTS` | Claude Code, Codex CLI, Cursor, OpenCode, Antigravity and ZCode desktop app, each marked as protected by zn, protected in one project only, not protected, or not found on this machine. |
| `WHAT THEY CAN REACH` | Secrets in the `.env` files of the folder (names only), credential files in your home folder (that they exist), and environment variables with a secret-looking name. |
| `MCP SERVERS` | Tools your agent can call that run a server from the agent configuration. Problems such as an unpinned version, a plain HTTP address or a secret written into the config. |
| `YOUR AGENT SETTINGS` | Agent settings in your home folder that apply to every project. |
| `PROJECT FILES THE AGENT RUNS` | Hooks, MCP servers, endpoint overrides, instruction files and executables in this folder that an agent loads or runs. |
| `NEXT` | At most two commands that fix the high findings. |

The `MCP SERVERS`, `YOUR AGENT SETTINGS` and `PROJECT FILES THE AGENT RUNS`
sections come from [`zn audit`](audit.md). Use `npx -y zn-gate audit` for the
full detail, and `npx -y zn-gate audit --include-home` to check your home
folder as well.

### Severity

Each finding has a severity: `high`, `medium`, `low` or `info`. The level
depends on whether a coding agent that zn does not protect is installed here:

- **high** (or **medium** for credential files): an agent that zn does not
  protect is installed, so it can read the file or the secret today.
- **low**: no supported agent is installed yet. The file is still there, and
  an agent you install later would be able to read it.
- **info**: every agent found is protected. The finding is shown for
  completeness and is never counted as a problem.

Environment variables with a secret are always `low`: they reach an agent
only when it is started from that terminal. Audit findings keep the severity
that `zn audit` gives them, with `critical` shown as `high`.

### What is checked, and how

- **Secrets in `.env` files.** Only the `.env` files of the folder you point
  at (not of its sub-folders) and only files named `.env` or `.env.<name>`.
  Example files (`.env.example`, `.env.sample`, `.env.template`, `.env.dist`,
  `.env.defaults`, `.env.schema`) are skipped. Each file is read up to 256 KB.
  Reach reports the names of the variables that hold a secret, and how many
  values are already zn markers (`__ZN_...__`), which it does not count. A
  `.env` that is a symbolic link is not followed; reach reports that it is a
  link.
- **Credential files.** A fixed list of files in your home folder: for
  example `~/.aws/credentials`, SSH private keys in `~/.ssh`, `~/.netrc`,
  `~/.npmrc`, `~/.pypirc`, `~/.git-credentials`, `~/.pgpass`,
  `~/.docker/config.json`, `~/.kube/config`, the GitHub CLI and Google Cloud
  and Azure token files. Reach only checks that they exist (it runs `stat`).
  It never opens them.
- **Environment variables.** The names of variables in the terminal that runs
  reach whose name ends like a secret (`API_KEY`, `TOKEN`, `SECRET`,
  `PASSWORD`, `PRIVATE_KEY` and similar), or whose value looks like a known
  secret format. Values shorter than 8 characters are ignored, and so are
  values such as `true`, `false` or plain numbers. `TOKEN_LIMIT` and `KEY_ID`
  are not matched by name.
- **Agents.** The same detection as [`zn-gate check`](check.md), set-up state
  only: reach does not start any hook.

### What is never shown

Reach never prints, stores or sends a secret value, in the text, JSON or SARIF
output, or in the memory file. Environment values are tested and then
dropped. Any text from a repository that reaches the report (file names,
titles, command lines) is passed through the same redaction as `zn audit`, and
control characters are replaced, so a file name cannot change your terminal.

## History: did your agents keep a secret of yours?

```bash
npx -y zn-gate reach --history
npx -y zn-gate reach --history --json
```

Coding agents save your conversations on your disk, in plain text, and a key
you pasted or a tool printed can sit there for weeks. `reach --history` reads
those local history files and tells you which kinds of secret they hold, how
many times, in which file, and what to do about it. It is for the "have my
agents already seen my keys?" question, and it works on your whole home
folder, not on one project, so it takes no folder.

It is read only and offline. It writes no file, not even the evidence log, and
it needs no account.

### Where it looks

Only files in your own home folder, and only these:

| Agent | Files |
| --- | --- |
| Claude Code | `~/.claude/projects/**/*.jsonl` (session transcripts) and `~/.claude/history.jsonl` (prompt history). `CLAUDE_CONFIG_DIR` is honoured when it points inside your home folder. |
| Codex CLI | `~/.codex/sessions/**/*.jsonl` and `~/.codex/history.jsonl`. `CODEX_HOME` is honoured when it points inside your home folder. |
| Cursor, OpenCode | Not scanned: they keep their history in a database, which this version does not read. The report says so. |

A link is never followed: a history file or folder that is a link is skipped
and listed, so a link cannot make the scan read something outside your home
folder.

### History: what it shows

```text
zn-gate reach --history: did your coding agents keep a secret of yours in their session history?
Read: the local history files of your agents in your home folder. Nothing was sent anywhere, nothing was changed, and no value is shown.

  Claude Code  42 files, 318 MB scanned
  Codex CLI    7 files, 12 MB scanned
  Cursor       not scanned: its history is a database, which this version does not read
  OpenCode     not scanned: its history is a database, which this version does not read

CLAUDE CODE
  ~/.claude/projects/-home-me-app/3f2a.jsonl
    2 x AWS_KEY
    Do this: Rotate this AWS access key in the AWS console (IAM), then delete this session file if you do not need it.

2 secrets in 1 file.

A key listed here may already be rotated. Check before you rotate.
zn-gate cannot see what was already sent to your model provider.
```

The output has a closed vocabulary: the agent, the path of the file, the
secret type (the same type names zn uses for markers, such as `AWS_KEY` or
`GITHUB_TOKEN`), how many times it appears, and the action. It never shows a
value, a part of a value, a prefix or a hash of one. Only secrets are
counted, not personal data, and a value that zn already replaced with a marker
(`__ZN_...__`) is not counted.

It uses the same secret patterns as the scrubber. A pattern can match
something that is not a live key, and a key can be already rotated: check
before you rotate.

### What it cannot tell you

zn-gate reads your disk. It cannot see what was already sent to the company
that runs your model, and it cannot delete anything there. Rotating a key
makes the copy in a history file harmless. Deleting the session file removes
the local copy only.

### Big histories and the time limit

Files are read in streaming mode, one line at a time, so a history of several
hundred MB does not fill memory (a 300 MB file takes a few seconds). The scan
stops after `--max-seconds` seconds (default 120, at most 3600), newest files
first. When it stops, the report lists the files that were not fully scanned
and never says that nothing was found. A line longer than 32 MB is skipped and
its file is listed as partly scanned.

### History: flags

| Flag | Meaning |
| --- | --- |
| `--history` | Scan the agent histories instead of a folder. It cannot be combined with a folder, `--sarif`, `--fail-on` or `--remember`. |
| `--json` | Print the result as JSON (schema below). |
| `--max-seconds N` | Time limit, a whole number from 1 to 3600. Default 120. |

Exit codes: `0` when the report was printed (also when secrets were found:
read `totals.secrets`), `2` for a usage error or a failure.

### JSON schema

`--json` prints one object. Version 1 of this schema keeps these keys and
meanings; a key is only added, never renamed or removed, within version 1.

```json
{
  "tool": "zn-gate reach --history",
  "version": 1,
  "agents": [
    { "id": "claude-code", "name": "Claude Code", "scanned": true, "reason": null, "files": 42, "bytes": 333447168 }
  ],
  "findings": [
    { "agent": "claude-code", "file": "~/.claude/projects/-home-me-app/3f2a.jsonl", "type": "AWS_KEY", "count": 2,
      "action": "Rotate this AWS access key in the AWS console (IAM), then delete this session file if you do not need it." }
  ],
  "incomplete": [
    { "agent": "claude-code", "file": "~/.claude/projects/-home-me-app/9c1d.jsonl", "reason": "time-limit" }
  ],
  "totals": { "files_scanned": 49, "bytes_scanned": 346030080, "files_with_secrets": 1, "secrets": 2, "files_not_reached": 0 },
  "time_limit_hit": false,
  "max_seconds": 120,
  "elapsed_ms": 6100,
  "notes": [
    "A key listed here may already be rotated. Check before you rotate.",
    "zn-gate cannot see what was already sent to your model provider."
  ]
}
```

- `agents[].id`: `claude-code`, `codex`, `cursor`, `opencode`, always in this
  order. `scanned` is `false` with `reason` `not-found` (no history folder) or
  `database` (not readable by this version); otherwise `reason` is `null`.
  `files` and `bytes` are what was read.
- `findings[]`: one entry per file and secret type, sorted by agent and then
  by `count`, highest first. `file` starts with `~/`. `type` matches
  `^[A-Z0-9_]+$`. `count` is the number of occurrences (an integer, 1 or
  more). `action` is plain text for people; scripts should rely on `type`.
- `incomplete[]`: files not fully scanned. `reason` is `time-limit`,
  `line-too-long`, `unreadable` or `symlink`. At most 200 are listed.
- `totals.files_not_reached`: files that were not started or were cut short
  because of the time limit.
- No finding ever holds a value, a fragment or a hash.

## Flags

| Flag | Meaning |
| --- | --- |
| `[path]` | The folder to check. Defaults to the current folder. It must be a folder. |
| `--json` | Print the report as JSON. |
| `--sarif` | Print the report as SARIF 2.1.0 for code scanning. |
| `--fail-on high\|medium\|low\|none` | Exit with code 1 when a finding of at least this severity is found. Default `none`: the report always exits 0. `info` findings never count. |
| `--remember` | Keep this run's counts, so the next run can say what they were. See below. |
| `--history` | Scan the local session histories of your agents instead of a folder. See [History](#history-did-your-agents-keep-a-secret-of-yours). |
| `-h`, `--help` | Show the usage. |

`--json` and `--sarif` cannot be used together.

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | The report was printed, and no finding met `--fail-on`. |
| `1` | A finding met `--fail-on`. |
| `2` | A usage error (unknown option, a bad `--fail-on` value, two folders), a path that is not a folder, or a failure while reach ran. |

Code `2` is kept apart from `1` so that a CI job can tell a broken run from a
finding.

### --remember

With `--remember`, reach writes one small file: `~/.zn/reach-last.json`, or
`reach-last.json` in the folder that `ZN_HOME` names when that variable is set.
For each folder it keeps the high, medium and low counts and the date of the
run. The key is a SHA-256 hash of the absolute folder path, cut to 32
characters, so the file holds no path, file name or value. At most 200 folders
are kept; the oldest go first. The next `--remember` run in the same folder
then shows, for example, `(last time, 2026-10-17: 2 high, 1 medium, 0 low)`.

Without `--remember`, reach writes no file.

## Example output

This is the real output of one run on a fake project. The `.env` holds two
fake secrets, the home folder holds a fake AWS credentials file, and a Claude
Code settings file exists but zn is not set up for it:

```text
zn-gate reach: what can the coding agents on this machine reach?
Read: agent settings in your home folder and this folder, .env files here, names of environment variables. Nothing was sent anywhere.

AGENTS
  Claude Code  not protected
  Codex CLI    not found on this machine
  Cursor       not found on this machine
  OpenCode     not found on this machine
  HIGH   Claude Code is on this machine and zn does not protect it
         It can read any file and run any command you allow.
         Fix: npx -y zn-gate init

WHAT THEY CAN REACH (secrets and credential files an agent could read; names only, never values)
  HIGH   .env in this folder has 2 secrets (OPENAI_API_KEY, DATABASE_URL)
         Claude Code can read them today.
         Fix: npx -y zn-gate env shadow .env
  MEDIUM 1 credential file in your home folder (~/.aws/credentials)
         Claude Code can read them today.
         Fix: npx -y zn-gate init

NEXT: fix the high ones
  1. npx -y zn-gate init
  2. npx -y zn-gate env shadow .env

2 high, 1 medium, 0 low.
```

Without any agent installed, the same two `.env` secrets are reported as
`LOW`, with the sentence "No coding agent was found here yet; one you install
would be able to read them.", and the `NEXT` block is left out.

With `--fail-on high`, that run exits with code 1.

## JSON

`--json` prints one object with these keys:

- `tool`, `version`: the tool name and the version of the report format.
- `root`: the absolute path of the folder checked. This is the only place the
  report contains a full path.
- `agents`: one entry per agent, with `id`, `name`, `found`, `state`
  (`protected`, `project-only`, `not-set-up`, or another state from `check`),
  `problem` and `fix`.
- `findings`: one entry per finding, sorted from high to low, with `section`,
  `severity`, `title`, `detail`, `fix` and, when they apply, `file`, `line`,
  `id` (an audit rule), `names` (secret names) and `files` (credential files
  by name).
- `counts`: how many findings there are per severity.
- `truncated`: `true` when the audit of the configuration ran out of time or
  entries. Then the report says that some files were not checked, and never
  that nothing needs fixing.
- `previous`: present only with `--remember`: the counts and date of the
  earlier run in this folder, or `null` when there is none.

## SARIF and CI

`--sarif` prints SARIF 2.1.0. Each finding about a file of the checked folder
becomes a result, with the rule `ZNR002` for a `.env` with secrets or the
rules of `zn audit` (`ZNA...`) for configuration files. Findings that belong
to the machine (an unprotected agent, credential files in the home folder,
environment variables) and findings about files outside the folder become
notifications of the run, because code scanning cannot place them in a file of
the repository. Info findings are left out.

A workflow that uploads the report to GitHub code scanning (actions pinned
to a full commit SHA, as in this repository's own workflows):

```yaml
name: zn reach

on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read
  security-events: write

jobs:
  reach:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          node-version: 22
      - name: Run zn-gate reach
        run: npx -y zn-gate reach --sarif > zn-reach.sarif
      - name: Upload to code scanning
        if: always()
        uses: github/codeql-action/upload-sarif@24c54180a607b1449ed407dd24f251e4e9147c8d # v4.38.3
        with:
          sarif_file: zn-reach.sarif
```

A CI runner normally has no coding agent installed, so in CI reach mainly
reports the `.env` files and the MCP and project settings of the repository.
Run it on a developer machine to see the agent and credential-file findings
too. To make the job fail on a finding, add `--fail-on high` to the `run` line.
The SARIF file is written before the exit code is known, so the upload step
(which runs with `if: always()`) still gets it.

## Privacy

- No network access. Reach does not call zn, a package registry or any other
  service.
- No account, no API key, no telemetry. A run is not counted in
  `zn-gate stats`.
- No value of a secret leaves the reach process, in any output format.
- Files are read only where the list above says so, and never written. The
  only file reach can write is the memory file, and only with `--remember`.

## Limits

- Reach checks one folder: its own `.env` files and its agent settings. It
  does not walk sub-folders for `.env` files. Use `npx -y zn-gate scan` or a
  secret scanner for the whole repository.
- The list of credential files and the list of secret names are fixed. A
  secret stored under a name that does not look like one is not reported by
  name. The environment check looks at names and at value formats only.
- The audit of the configuration stops after about 2.5 seconds or 20,000
  entries, and then says so in the report.
- Reach does not tell you whether an agent would really open a file. It tells
  you what the file system and the agent setup allow.
- "Protected" means zn's hooks are set up for that agent. What each agent
  covers differs: in Cursor, for example, shell output and file contents are
  not scrubbed. See [what each agent supports](compat.md).

## If something fails

- **Exit code 2**: reach did not run or stopped with an error. Check that the path is a folder and that you used only one folder and valid options. `--json` and `--sarif` cannot be used together.
- **Exit code 1 in CI**: a finding met `--fail-on`. Read the report. Use `--fail-on none` to report without failing.
- **A `.env` file in a sub-folder is missing from the report**: reach checks one folder. Run it in that folder, or use `npx -y zn-gate scan`.
- **The report says some files were not checked in time**: the check stops after about 2.5 seconds or 20,000 entries. Run `npx -y zn-gate audit --include-home` to check them all.

## Next steps

- Fix the high findings with the commands the report prints, in this order:
  `npx -y zn-gate init`, then `npx -y zn-gate env shadow <file>`.
- Test the protection with `npx -y zn-gate check`.
- To undo `env shadow`, run the restore command that `env shadow` prints
  (`npx -y zn-gate env unshadow FILE --backup <name>`), in your own terminal.
