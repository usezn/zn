# Example: reading severity levels in reach output

A short walk-through of the severity levels in [`zn-gate reach`](../reach.md). Every finding starts with a level: `HIGH`, `MEDIUM`, `LOW` or `INFO`. This page shows when each level appears, with the real output of runs on a fake project. For all flags and limits, read the [full page](../reach.md).

The output below comes from runs in a throwaway home folder. The project is a folder called `my-app` with a `.env` that holds two fake secrets (`OPENAI_API_KEY` and `DATABASE_URL`). The home folder holds a fake `~/.aws/credentials` file. Your own report lists your own files and agents.

## The levels at a glance

| Level | What it means | Counted in the summary line | Counted by `--fail-on` |
| --- | --- | --- | --- |
| `HIGH` | A coding agent that zn does not protect can read the secret or run the setting today. | Yes | Yes |
| `MEDIUM` | The same risk for credential files in your home folder, or an agent protected in one project only. | Yes | Yes |
| `LOW` | No supported agent is installed yet, so nothing can read the file today. An agent you install later could. Also environment variables with a secret. | Yes | Yes |
| `INFO` | Every agent found is protected. Shown for completeness. | No | Never |

The level of a secret or a credential file depends on the agents on the machine. The same `.env` is `HIGH`, `LOW` or `INFO` in the three cases below.

## No agent installed: LOW

A new machine with no supported coding agent:

```bash
npx -y zn-gate reach .
```

```text
zn-gate reach: what can the coding agents on this machine reach?
Read: agent settings in your home folder and this folder, .env files here, names of environment variables. Nothing was sent anywhere.

AGENTS
  Claude Code  not found on this machine
  Codex CLI    not found on this machine
  Cursor       not found on this machine
  OpenCode     not found on this machine
  Antigravity  not found on this machine
  GitHub Copilot (VS Code, CLI) not found on this machine
  Gemini CLI (experimental) not found on this machine
  ZCode        not found on this machine

WHAT THEY CAN REACH (secrets and credential files an agent could read; names only, never values)
  LOW    .env in this folder has 2 secrets (OPENAI_API_KEY, DATABASE_URL)
         No coding agent was found here yet; one you install would be able to read them.
         Fix: npx -y zn-gate env shadow .env
  LOW    1 credential file in your home folder (~/.aws/credentials)
         No coding agent was found here yet; one you install would be able to read them.

0 high, 0 medium, 2 low.
```

Nothing can read these files today, so both findings are `LOW`. There is no `NEXT` block, because that block only lists fixes for `HIGH` findings.

## An agent is installed and not protected: HIGH and MEDIUM

Now Claude Code is on the machine (its settings folder exists), and zn is not set up for it:

```text
AGENTS
  Claude Code  not protected
  Codex CLI    not found on this machine
  Cursor       not found on this machine
  OpenCode     not found on this machine
  Antigravity  not found on this machine
  GitHub Copilot (VS Code, CLI) not found on this machine
  Gemini CLI (experimental) not found on this machine
  ZCode        not found on this machine
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

Read it like this:

- The agent that zn does not protect is itself a `HIGH` finding.
- A `.env` with secrets becomes `HIGH`, because the agent can read it today.
- A credential file in your home folder becomes `MEDIUM`, one level below a `.env`. Reach only checks that the file exists. It never opens it.
- `NEXT` repeats the fixes for the `HIGH` findings, at most two commands.

An agent that zn protects in one project only gets its own `MEDIUM` finding, `Claude Code is protected in one project only`, with the sentence `zn is set up for one folder, not for your user.` That agent still counts as not fully protected, so the `.env` stays `HIGH`.

## Every agent is protected: INFO

After zn is set up for your user, the same `.env` and the credential file are reported as `INFO`. When that is the only kind of finding, the text report says so and stops:

```text
AGENTS
  Claude Code  protected by zn (run `zn-gate check` to test it)
  Codex CLI    not found on this machine
  Cursor       not found on this machine
  OpenCode     not found on this machine
  Antigravity  not found on this machine
  GitHub Copilot (VS Code, CLI) not found on this machine
  Gemini CLI (experimental) not found on this machine
  ZCode        not found on this machine

Nothing to fix. Your agents run with zn-gate.
```

`INFO` findings are left out of the text when nothing else needs fixing. With `--json` they are still there, with the sentence `zn stops your agents from reading them.` in `detail`, and `counts.info` is `2` for this project. When other findings exist, an `INFO` line is printed next to them, as `INFO   .env in this folder has 1 secret (OPENAI_API_KEY)`.

## Environment variables are always LOW

A variable with a secret-looking name reaches an agent only when the agent starts from that terminal, so reach never rates it above `LOW`, whatever agents are installed. This run has the fake variable `MY_SERVICE_API_KEY` set:

```text
WHAT THEY CAN REACH (secrets and credential files an agent could read; names only, never values)
  LOW    1 environment variable with a secret (MY_SERVICE_API_KEY)
         An agent started from this terminal gets their values.
         Fix: keep them in zn's vault: run `npx -y zn-gate secret set NAME` in your own terminal, then use __ZN_NAME__ where the value goes

0 high, 0 medium, 1 low.
```

Only the name is shown, never the value.

## Findings from the project files

The `MCP SERVERS`, `YOUR AGENT SETTINGS` and `PROJECT FILES THE AGENT RUNS` sections come from [`zn-gate audit`](../audit.md). Each finding keeps the level that audit gives it. Audit's `critical` is shown as `HIGH`, so reach has no `CRITICAL` level.

A project with a `.mcp.json` that runs an unpinned package with `npx` and points a server at an `http://` address gives, with the same fake home folder:

```text
MCP SERVERS (extra tools your agent can call)
  MEDIUM Project MCP server starts a local command [.mcp.json:1]
         MCP server "demo" runs: npx -y demo-server
         Fix: Check the command and its package before approving the server; prefer pinned versions, or move the server to your user config.
  MEDIUM MCP server or agent plugin package is not pinned [.mcp.json:1]
         MCP server "demo" runs demo-server through npx without an exact version.
         Fix: Pin an exact version (pkg@1.2.3, pkg==1.2.3, image@sha256:...).
  MEDIUM Remote MCP server or remote instructions [.mcp.json:1]
         MCP server "remote" uses unencrypted http://mcp.example.com.
         Fix: Use https and a server you trust; keep remote instructions out of the repository.
```

The file name and line follow in square brackets, so you can open the file.

## Make the exit code follow the levels

By default reach exits `0` after printing the report. `--fail-on` turns a level into a failure:

```bash
npx -y zn-gate reach . --fail-on low
```

In the first run above (no agent installed), this exits `1`, because the two `LOW` findings meet `--fail-on low`. With `--fail-on medium` or `--fail-on high` it exits `0` there. In the run with an unprotected agent, `--fail-on high`, `medium` and `low` all exit `1`, and `--fail-on none` exits `0`.

`INFO` never counts: in the run where every agent is protected, `--fail-on high` and `--fail-on low` both exit `0`. The accepted values are `high`, `medium`, `low` and `none`. Anything else, `critical` included, is a usage error:

```text
zn-gate reach: --fail-on must be one of high, medium, low, none
```

That run exits `2`, which stays apart from `1` so that a CI job can tell a broken run from a finding.

## If something looks wrong

- **A `.env` is `LOW` but you use an agent**: reach did not find the agent. Run `npx -y zn-gate check` to see which agents it detects.
- **A finding you do not expect is `HIGH`**: read its `Fix:` line. For a `.env`, it is `npx -y zn-gate env shadow .env`.
- **A `.env` in a sub-folder is missing**: reach checks one folder. Run it in that folder.

## More

More in [what reach shows](../reach.md#what-it-shows), the [severity rules](../reach.md#severity) and the [flags](../reach.md#flags).
