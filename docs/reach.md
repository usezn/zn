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
| `AGENTS` | Claude Code, Codex CLI, Cursor and OpenCode, each marked as protected by zn, protected in one project only, not protected, or not found on this machine. |
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

## Flags

| Flag | Meaning |
| --- | --- |
| `[path]` | The folder to check. Defaults to the current folder. It must be a folder. |
| `--json` | Print the report as JSON. |
| `--sarif` | Print the report as SARIF 2.1.0 for code scanning. |
| `--fail-on high\|medium\|low\|none` | Exit with code 1 when a finding of at least this severity is found. Default `none`: the report always exits 0. `info` findings never count. |
| `--remember` | Keep this run's counts, so the next run can say what they were. See below. |
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

```
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

## Next steps

- Fix the high findings with the commands the report prints, in this order:
  `npx -y zn-gate init`, then `npx -y zn-gate env shadow <file>`.
- Test the protection with `npx -y zn-gate check`.
- To undo `env shadow`, run the restore command that `env shadow` prints
  (`npx -y zn-gate env unshadow FILE --backup <name>`), in your own terminal.
