# Exit codes

One page with the exit code of every `zn-gate` command, and of the GitHub Action. It repeats what [Command line reference](cli.md) and [GitHub Action](github-action.md) say; read those pages for the full detail of each command.

A command that succeeds exits with `0`. A command that is not listed here with a code does not use it.

## Common codes

| Code | Meaning |
|---|---|
| `0` | Done, or nothing to report. |
| `1` | The command ran and found a problem (findings, a failed check, an error), or the command name is unknown. |
| `2` | The command was used wrongly, or `analyze` blocked the text. |
| `64` | Wrong usage, for the secrets commands (`secret`, `env`, `hooks`, `vault log`, `run`). |
| `77` | zn refused on purpose, for example to print a secret value. |
| `127` | `run` could not find the program you asked it to start. |

## Set up and check

| Command | Codes | Meaning |
|---|---|---|
| `init` | `0`, `1`, `2` | `0` done or already protected; `1` no supported agent found, or the steps were only printed; `2` an unknown argument. |
| `uninstall` | `0`, `1`, `64`, `77` | `0` removed or nothing to remove; `1` you answered no or a step failed; `64` an unknown option; `77` no interactive terminal or an agent ran it, so nothing changed. |
| `check` (`doctor`) | `0`, `1` | `0` every agent that is set up is protected; `1` an agent is not protected, or none is set up. |
| `status` | `0` | Always `0`. |
| `test` | `0`, `1` | `0` all built-in examples passed; `1` at least one failed. |
| `version` | `0` | Always `0`. |
| `connect` | `0`, `1`, `2` | `0` connected or already connected; `1` nothing was saved; `2` the command was used wrongly. |
| `disconnect` | `0`, `1`, `2` | `0` the local setting was removed or there was nothing to remove; `1` something was not done; `2` the command was used wrongly. |

## Scan and review

| Command | Codes | Meaning |
|---|---|---|
| `scan` | `0`, `1`, `2` | `0` nothing found; `1` something was found or the path does not exist; `2` an unknown `--format`. |
| `audit` | `0`, `1`, `2` | `0` nothing at or above `--fail-on`; `1` findings at or above it; `2` wrong usage or a path that is not a folder. |
| `reach` | `0`, `1`, `2` | `0` done; `1` findings meet `--fail-on`; `2` wrong usage or a failure. |
| `analyze` | `0`, `1`, `2` | `0` the text is allowed; `1` no text given; `2` the text is blocked. |
| `pins` | `0`, `2` | `0` done; `2` wrong usage, no terminal, an agent running it, or the approval was not confirmed. |

## Secrets and the vault

| Command | Codes | Meaning |
|---|---|---|
| `secret`, `env`, `hooks`, `vault log` | `0`, `1`, `64`, `77` | `0` done; `1` another error; `64` wrong usage; `77` refused on purpose (`secret get` always exits `77`). |
| `run` | the code of your command, `1`, `64`, `77`, `127` | Your command's own code; `1` another error; `64` wrong usage; `77` not allowed or not approved; `127` the program was not found. |
| `unlock` | `0`, `1`, `2` | `0` unlocked; `1` an error, for example the vault could not be opened; `2` the command was used wrongly. |
| `lock` | `0`, `2` | `0` done, also when the vault was not unlocked; `2` the command was used wrongly. |
| `vault` and `vault status` | `0`, `2` | `0` done; `2` wrong usage. |
| `vault log export` | `0`, `1`, `2` | `0` done; `1` error; `2` without `--otlp`. |
| `vault verify` | `0`, `1`, `2` | `0` the audit log is correct; `1` it is broken; `2` wrong usage. |
| `vault forget` | `1`, `2` | `1` when the vault is not locked; `2` wrong usage. |
| `vault reset` | `0`, `1`, `2` | `0` done or there was no vault; `1` refused or cancelled; `2` wrong usage. |

## Agents and MCP servers

| Command | Codes | Meaning |
|---|---|---|
| `hook` | `0`, `1`, `2` | `0` the action is allowed; `2` it is blocked, or the event cannot be read; `1` unknown agent. |
| `shield` | `1` | `1` when no command is given or the program cannot be started; otherwise it ends when the wrapped server ends. |
| `mcp`, `secrets-mcp` | server | They exit when the server stops. |

## Logs and reports

| Command | Codes | Meaning |
|---|---|---|
| `evidence --verify` | `1` | `1` when the SHA-256 chain was changed. |
| `stats` | `0`, `2` | `0` done; `2` wrong usage. |
| `stats share on` | `1` | `1` when you do not confirm. |
| `report` | `0`, `2` | `0` done; `2` wrong usage. |

## zn Team

| Command | Codes | Meaning |
|---|---|---|
| `team` and `team status` | `0`, `1`, `2` | `0` done; `1` an error; `2` wrong usage. |
| `team sync` | `1` | `1` when the policy is rejected or the machine was removed. |

## GitHub Action

The Action exposes the exit code of each step as an output. See [GitHub Action](github-action.md).

| Output | Codes | Meaning |
|---|---|---|
| `scan-exit-code` | `0`, `1`, `2` | `0` clean; `1` findings; `2` error; empty if the scan did not run. |
| `audit-exit-code` | `0`, `1`, `2` | `0` clean; `1` findings at or above the threshold; `2` error; empty if the audit did not run. |

With `fail-on-threat: 'false'` the exit codes stay `0`, so do not use these outputs to detect findings in report-only mode.
