# Exit codes

One page with the exit code of every `zn-gate` command, and of the GitHub Action. It repeats what [Command line reference](cli.md) and [GitHub Action](github-action.md) say; read those pages for the full detail of each command.

A command that succeeds exits with `0`. A command that is not listed here with a code does not use it.

## Quick reference

One row per exit code. The source column gives the line that returns the code, so you can check each row in the code. The per-command tables below list the codes each command uses.

| Code | Meaning | Commands that return it | Usual fix | Source |
|---|---|---|---|---|
| `0` | Done, or nothing to report. | `scan` with no findings; `check` and `doctor` when every agent that is set up is protected; `check --hooks` when every hook is OK; `hook` when the action is allowed; `analyze` when the text is allowed. | Nothing to fix. | `bin/cli.js:739`, `lib/check.js:1515`, `lib/hooks-list.js:185` |
| `1` | The command ran and found a problem, or it failed. | `scan` with findings, or with a path that does not exist; `check` and `doctor` when an agent is not protected or the project rules have errors; `check --hooks` when a hook is stale or broken; `evidence --verify` when the log chain is broken; `analyze` with no text; `hook` when the agent name is unknown; `uninstall` when you answer no or a step fails. | Read the message. Run `zn-gate check` in your own terminal to see which agent or rule needs a fix. | `bin/cli.js:736`, `bin/cli.js:578`, `lib/check.js:1515`, `bin/cli.js:1299`, `lib/hooks-list.js:185`, `bin/cli.js:1221`, `bin/cli.js:1337`, `lib/hooks/runner.js:2302`, `lib/uninstall.js:216`, `lib/uninstall.js:269` |
| `2` | The command was used wrongly, or the action was blocked. | `scan` with an unknown `--format`; `reach` with a wrong option or a path that is not a folder; `analyze` when the text is blocked; `hook` when the action is blocked. | For a usage error, check the options in the [command line reference](cli.md) and run the command again. For a block, read the message and follow its next step in your own terminal. Do not look for a way around the block. | `bin/cli.js:584`, `bin/cli.js:926`, `bin/cli.js:1345`, `lib/hooks/runner.js:2035` |
| `3` | A scan read no file, or skipped a file or folder it should have read. | `scan` | Fix the access problem, or check the path. Use `--allow-partial` only when you accept the skipped items. | `bin/cli.js:737`, `bin/cli.js:738` |
| `64` | Wrong usage for the run and secrets commands. | `run`, `secret`, `env`, `hooks`, `vault log` (see [secrets and the vault](#secrets-and-the-vault)). | Check the command name and options in the [command line reference](cli.md), then run it again. | `lib/broker/run.js:497`, `lib/broker/cli.js:621` |
| `77` | zn refused on purpose: a value was not shown, or the action was not allowed or not approved. | `run`, `secret`, `env`, `hooks`, `vault log` (see [secrets and the vault](#secrets-and-the-vault)). | If the action is needed, the user runs it in their own terminal. | `lib/broker/run.js:498`, `lib/broker/cli.js:621` |
| `127` | The program that `run` was asked to start was not found. | `run` | Check the program name and that it is on your PATH, then run the command again. | `lib/broker/run.js:499` |

zn-gate does not return `126`. A command that zn-gate starts ends with its own code when it stops, for example 143 or 137 after a time limit (`lib/agents/launcher.js:306`).

## Which exit code in a script

In a script, these three codes are the ones you will check most. The [full table](#common-codes) and the per-command tables below list the rest.

| Code | What to do in the script |
|---|---|
| `0` | Carry on: the command is done, or it found nothing to report. |
| `1` | Stop and look: the command ran and found a problem. |
| `2` | Fix the call: the command was used wrongly, or `analyze` blocked the text. |

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
| `init` | `0`, `1`, `2` | `0` done or already protected; `1` no supported agent found, or the steps were only printed, or (with `--wrap-mcp`) a config could not be changed, for example because the disk is full; `2` an unknown argument. |
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
| `scan` | `0`, `1`, `2`, `3` | `0` nothing found and everything that matched was read; `1` something was found or the path does not exist; `2` an unknown `--format`; `3` the coverage is incomplete: no file was read, or a file or folder that should have been read was not. |
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
| `vault verify` | `0`, `1`, `2` | `0` the vault audit log is correct; `1` it is broken; `2` wrong usage. |
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

## The Python package

The Python package (`pip install zn-gate`) has a smaller command line than the npm package. Its commands are in [The Python package](cli.md#the-python-package); this is what they exit with:

| Command | Codes | Meaning |
|---|---|---|
| `test "<text>"` | `0`, `1` | `0` nothing was flagged; `1` the text was blocked or contains a secret. It does not run the self-test that `test` runs in the npm package. |
| `analyze "<text>"` | `0`, `2` | `0` the text is allowed; `2` the text is blocked; without a text, `2` (the npm package exits `1`). |
| `scan [path]` | `0`, `1`, `3` | `0` nothing found; `1` something was found or the path does not exist; `3` no file was read, or a file or folder could not be read (`--allow-partial` accepts the files it could not read; reading no file at all stays `3`). `--no-fail` always exits `0`. |
| `evidence` | `0`, `1` | `0` done; `1` `--verify` found a changed SHA-256 chain, or the export was not saved. |
| `status` | `0` | Always `0`. |
| `stats` | `0`, `2` | `0` done; `2` `--days` is out of range (1 to 90). |
| The other commands on this page | `2` | They exist only in the npm package: the Python package prints a short note that points to it, then exits `2`. `help` does the same. |

`version` exits `0` here as in the npm package, and `reach --history` is part of the Python package too (see [reach](reach.md#history-did-your-agents-keep-a-secret-of-yours)). A command neither package knows exits `1`.

## GitHub Action

The Action exposes the exit code of each step as an output. See [GitHub Action](github-action.md).

| Output | Codes | Meaning |
|---|---|---|
| `scan-exit-code` | `0`, `1`, `2`, `3` | `0` clean; `1` findings; `2` error; `3` no file was read, or a file or folder was not read; empty if the scan did not run. |
| `audit-exit-code` | `0`, `1`, `2` | `0` clean; `1` findings at or above the threshold; `2` error; empty if the audit did not run. |

With `fail-on-threat: 'false'` the exit codes stay `0`, so do not use these outputs to detect findings in report-only mode.

## Reading exit codes in a Makefile

`make` stops a target at the first command that exits with a non-zero code, and it does not say which code it was. To react to a code, save it with `$$?` and read it in the same shell command. This target treats the three non-zero codes of `scan` differently:

<!-- markdownlint-disable MD010 -->
```make
scan:
	@zn-gate scan . ; code=$$? ; \
	case $$code in \
	  0) echo "scan: clean" ;; \
	  1) echo "scan: findings, see the list above" ; exit 1 ;; \
	  3) echo "scan: not everything was read, see the output above" ; exit 1 ;; \
	  *) echo "scan: could not run (exit $$code), check the command" ; exit $$code ;; \
	esac
```
<!-- markdownlint-enable MD010 -->

- `0` means nothing was found and everything that matched was read, so the target passes.
- `1` means the scan found something (or the path does not exist). Fix the findings.
- `3` means no file was read, or a file or folder that should have been read was not. This is not a clean result. Fix the cause, or add `--allow-partial` to the `zn-gate scan` line if you accept the skipped files; with that flag a scan that found nothing exits `0`.
- `2` means the command itself was used wrongly, for example an unknown option or a `--format` that is not `text`, `json` or `github`. Fix the line, not the project.

Inside a Makefile every `$` is written `$$`, and each line of the recipe ends with a backslash so the whole `case` runs in one shell. See [Scan and review](#scan-and-review) for the codes of the other commands.
