# Command line reference

Every command of the `zn-gate` program, with its options and exit codes. For a first walk through, start with [First 5 minutes](first-5-minutes.md).

## Program names

The package installs three names. They are the same program, so every command below works with any of them:

- `zn-gate`
- `zn`
- `zn-mcp`

Without installing, use `npx -y zn-gate <command>`. This page writes `zn-gate` in examples.

`zn-gate --help` (or `-h`) prints the short help. `zn-gate version`, `zn-gate -V` and `zn-gate --version` print the version.

## Exit codes

A command that succeeds exits with `0`. The other codes depend on the command and are listed under each one. These are the common ones:

| Code | Meaning |
|---|---|
| `0` | Done, or nothing to report. |
| `1` | The command ran and found a problem (findings, a check that failed, an error), or the command name is unknown. |
| `2` | The command was used wrongly (an option it does not know, a missing value), or `analyze` blocked the text. |
| `64` | Wrong usage, for the secrets commands (`secret`, `env`, `hooks`, `vault log`, `run`). |
| `77` | zn refused on purpose, for example to print a secret value, or to run a command you have not allowed. |
| `127` | `run` could not find the program you asked it to start. |

The commands that start a long-running server (`mcp`, `shield`, `secrets-mcp`) exit when the server stops. A hook (`hook`) exits `2` to block an action, as the agent expects.

## Settings

| Setting | Effect |
|---|---|
| `ZN_API_KEY` or `--key <api_key>` | API key for the optional cloud check. Used only by `analyze` and `analyze_prompt`, and only when the cloud check is on. |
| `ZN_CLOUD=1` | Turns the optional cloud check on. Without it (or `zn-gate connect`) nothing leaves your machine. |
| `ZN_LOCAL_ONLY=true` or `--local-only` | Never use the cloud, even when `ZN_CLOUD=1` is set. |
| `ZN_STAGE` or `--stage <v30\|prod>` | Cloud stage. Default `v30`. |
| `ZN_API_URL` or `--url <url>` | Use another cloud address. |
| `--long-input <windows\|off>` | How long texts are sent to the cloud check: in overlapping windows (default, up to 20), or only the first 512 tokens. Any other value exits `2`. |
| `ZN_STATS=off` | Turns off the local counts shown by `stats` and `report`. |
| `ZN_VERBOSE=1` or `--verbose` | Prints debug messages to the error output. |
| `NO_COLOR` | Turns off colors. |

## Set up and check

### `init`

```bash
zn-gate init
zn-gate init --wrap-mcp [--dry-run] [--shadow] [--revert]
```

Without options, `init` is the guided setup: it finds the coding agents on this machine (Claude Code, Codex CLI, Cursor, OpenCode), shows what is missing and, in your own terminal, asks before each step. It takes no other arguments. When it runs without a terminal, or an AI agent runs it, it only prints the steps and changes nothing.

With `--wrap-mcp` it finds the MCP servers in known agent configs and wraps them with `shield`. Backups are written first.

- `--dry-run`: show what would change, change nothing.
- `--shadow`: wrap in shadow mode: problems are logged but nothing is dropped.
- `--revert`: restore the backups made before zn changed the configs.

`--dry-run`, `--shadow` and `--revert` each select `--wrap-mcp` too.

Exit codes: `0` done, or every agent found is already protected. `1` no supported agent found, or the steps were only printed. `2` an argument it does not know.

### `check`

```bash
zn-gate check
```

Shows that zn stops your agent from reading a fake secret, in a temporary folder. Nothing is sent and no setting changes. [What the output means](check.md).

Aliases: `doctor`.

Exit codes: `0` every agent that is set up is protected. `1` an agent is not protected, or none is set up.

### `status`

```bash
zn-gate status
```

Shows the version, the rules version, whether the optional cloud check is on and where the API key comes from. Always exits `0`.

### `test`

```bash
zn-gate test
```

Runs the local self-test on built-in examples (attacks and ordinary developer text). It never uses the network. Exit codes: `0` all passed, `1` at least one example failed.

### `version`

```bash
zn-gate version
```

Prints the version and the versions of the rules. Exit code `0`. `-V` and `--version` do the same.

## Scan and review

### `scan`

```bash
zn-gate scan [path] [--format text|json|github] [--all] [--include .rst,.xml] [--exclude fixtures,legacy] [--include-home]
```

Looks through prompt templates, markdown, skills and configs for injection traps and secrets. `path` defaults to the current folder. Matched values are never printed.

- `--format`: `text` (default), `json`, or `github` (workflow annotations for CI).
- `--all` (or `--code`): include source code files.
- `--include`: more file extensions to scan.
- `--exclude`: more folders to skip.
- `--include-home`: also check your own MCP configs for passwords and keys written in plain text.

Exit codes: `0` nothing found, `1` something was found or the path does not exist, `2` an unknown `--format`.

### `audit`

```bash
zn-gate audit [path] [--format text|json|sarif] [--output file] [--fail-on high] [--agents claude,codex,all] [--include-home]
```

Reviews the agent configs of a folder before you open it: hooks, MCP servers, endpoint overrides, permissions, instructions and planted programs. It runs nothing. [What it finds](audit.md).

- `--format`: `text` (default), `json` or `sarif`.
- `--output` (or `-o`): write the report to a file.
- `--fail-on`: `low`, `medium`, `high` (default), `critical` or `none`.
- `--agents`: a comma-separated list of `claude`, `codex`, `cursor`, `opencode`, `amazonq`, `copilot`, `gemini`, or `all` (default).
- `--include-home`: also review your own agent configs in your home folder.

Exit codes: `0` nothing at or above `--fail-on`, `1` findings at or above it, `2` wrong usage or a path that is not a folder.

### `reach`

```bash
zn-gate reach [path] [--json | --sarif] [--fail-on high|medium|low|none] [--remember]
```

Shows what your coding agents can reach from a folder: secrets (names only), credential files and MCP servers. Read only, nothing is sent. [What it shows](reach.md).

- `--fail-on`: default `none`, so it is a report.
- `--remember`: keep this run's counts for the next run.

Exit codes: `0` done, `1` findings meet `--fail-on`, `2` wrong usage or a failure (so CI can tell it from findings).

### `analyze`

```bash
zn-gate analyze "<text>"
```

Checks a piece of text for prompt injection and prints the answer as JSON. It is local; the optional cloud check is used only when it is on. Exit codes: `0` allowed, `1` no text given, `2` blocked.

### `pins`

```bash
zn-gate pins
zn-gate pins approve <server>
zn-gate pins approve --all
```

`pins` lists the MCP servers that `shield` has pinned and any tools that changed. `pins approve` accepts the changes. Approving is for you: it needs an interactive terminal, asks you to type the server key again, and refuses to run under an AI agent.

Exit codes: `0` done, `2` wrong usage, no terminal, an agent running it, or the approval was not confirmed.

#### `pins approve`

Accepts the changed or new tools of one server, or of every server with `--all`.

## Secrets and the vault

Secret values stay on this machine in an encrypted vault; agents only see markers such as `__ZN_AWS_KEY__`. Commands that add, change or remove a value need an interactive terminal and refuse to run inside an agent. A value is never accepted as an argument. [Walkthrough](secrets.md).

The exit codes of `secret`, `env`, `hooks`, `vault log` and `run` are `0` done, `1` another error, `64` wrong usage, `77` refused on purpose.

### `secret`

```bash
zn-gate secret <set|list|rm|allow|approve|import|adopt|log> ...
```

Groups the commands below. Run `zn-gate secret --help` for the short usage.

Aliases: `secrets`.

#### `secret set`

```bash
zn-gate secret set NAME [--clipboard] [--force] [--mode proxy|env|file] [--host api.example.com] [--command psql] [--in header|query|body]
```

Stores a secret. You type the value at a hidden prompt, or use `--clipboard`. `--force` replaces an existing secret. `--host`, `--command` and `--in` set where it may be used; `--mode` sets how it is filled in.

#### `secret list`

```bash
zn-gate secret list
```

Lists the stored secrets: names and policy, never values.

Aliases: `secret ls`.

#### `secret rm`

```bash
zn-gate secret rm NAME
```

Removes a secret.

Aliases: `secret remove`.

#### `secret allow`

```bash
zn-gate secret allow NAME [--host api.example.com] [--command psql] [--in header|query|body] [--mode proxy|env|file] [--replace]
```

Adds allowed hosts or commands to a secret. At least one option is needed. `--replace` swaps the lists instead of adding to them. The change is confirmed in the vault prompt.

#### `secret approve`

```bash
zn-gate secret approve NAME --command "psql"
```

Approves the first use of a secret by a command that is already allowed. It is confirmed in the vault prompt.

#### `secret import`

```bash
zn-gate secret import [FILE] [--all] [--keys A,B] [--host H] [--command C] [--force]
```

Copies the secret values of a `.env` file (default `.env`) into the vault. The file is not changed.

#### `secret adopt`

```bash
zn-gate secret adopt AWS_KEY_1 --name AWS_PROD [--host H] [--command C]
```

Stores a value that the scrubber detected (named like `AWS_KEY_1`) as a named secret.

#### `secret log`

```bash
zn-gate secret log [--since 1h]
```

Shows who used which secret where, without values, then checks the log chain. Same as `vault log`.

#### `secret get`

There is no way to print a secret value: `secret get` exits `77` and points you to `run`, which uses the value without showing it.

Aliases: `secret reveal`.

### `env`

```bash
zn-gate env <shadow|unshadow> ...
```

Groups the two commands below. Run `zn-gate env --help` for the short usage.

#### `env shadow`

```bash
zn-gate env shadow [FILE] [--all] [--keys A,B] [--host H] [--command C] [--force] [--dry-run]
```

Moves the values of a `.env` file (default `.env`) into the vault and leaves markers in the file. It prints the name of an encrypted copy of the original, so you can undo it. `--dry-run` only lists what would move.

#### `env unshadow`

```bash
zn-gate env unshadow FILE --backup ENVBAK_NAME
```

Puts the original values back into the file from the encrypted copy that `env shadow` printed.

### `run`

```bash
zn-gate run [--secrets NAME[,NAME...]] [--agent ID] -- <command> [args...]
```

Runs a command with markers replaced by real values, only for commands you allowed, and masks the values in its output. Everything after `--` belongs to your command. `-s` is short for `--secrets`.

Exit codes: the exit code of your command; `64` wrong usage, `77` refused (not allowed or not approved), `127` the program was not found, `1` another error.

### `unlock`

```bash
zn-gate unlock [--ttl 8h] [--idle 30m] [--backend name] [--passphrase-stdin] [--foreground]
```

Unlocks the vault for this session. The first run creates it. `--ttl` and `--idle` take a number with `s`, `m` or `h` (between 1 minute and 24 hours). `--passphrase-stdin` reads the passphrase from a pipe when there is no system keychain. `--foreground` keeps the vault in this terminal and asks for confirmations here. It refuses to run under an AI agent.

Exit codes: `0` unlocked, `1` an error.

### `lock`

```bash
zn-gate lock
```

Locks the vault now. Exit code `0`.

### `vault`

```bash
zn-gate vault <status|log|verify|forget|team|reset>
```

With no subcommand it is the same as `vault status`. Usage errors exit `2`.

#### `vault status`

Shows whether the vault exists and is unlocked.

#### `vault log`

```bash
zn-gate vault log [--since 1h]
```

Shows the audit log of secret use. Same as `secret log`. Exit codes follow the secrets commands above.

#### `vault log export`

```bash
zn-gate vault log export --otlp [--since 7d] [--out file]
```

Writes the audit log as OpenTelemetry logs (OTLP, JSON Lines) to the file, or to the screen. Needs no account. Exit codes: `0` done, `1` error, `2` without `--otlp`. [Details](team.md).

#### `vault verify`

Checks the chain and signatures of the audit log. Exit codes: `0` correct, `1` broken.

#### `vault forget`

```bash
zn-gate vault forget [dir]
```

Forgets the token map of a project (default: the current folder). The vault must be locked: otherwise it exits `1`.

#### `vault reset`

```bash
zn-gate vault reset
```

The way out when you lost the vault passphrase. It sets the old vault aside in a backup folder (`~/.zn/vault-backup-<date>`, still encrypted) and starts again with a new, empty vault the next time you run `unlock`. The values stored in the old vault are lost: nobody can read them without the old passphrase. It needs a person at a terminal, the vault must be locked, and you confirm by typing a phrase. It refuses on a machine that belongs to a zn Team organization. Exit codes: `0` done (or there was no vault), `1` refused or cancelled.

#### `vault team`

Prints that a shared team vault is planned and not available, and counts the request on this machine only (see `stats`). Nothing is sent.

### `hooks`

```bash
zn-gate hooks install <agent> [--project] [--no-mcp]
zn-gate hooks uninstall <agent> [--project] [--no-mcp]
```

Adds or removes the zn hooks of a coding agent. `<agent>` is `claude-code`, `codex`, `cursor`, `opencode`, `antigravity`, `gemini` or `copilot` (`claude` is accepted for `claude-code`, `gemini-cli` for `gemini`). `--project` changes the settings of the current project instead of your user settings. `--no-mcp` leaves the `secrets` MCP server out. It needs an interactive terminal. An agent that is not in that list or a misspelled name is refused first, with the supported names, and exit code 64.

#### `hooks install`

Adds the hooks, and the `secrets` MCP server unless `--no-mcp` is given. A backup of the settings is written first.

#### `hooks uninstall`

Removes them again.

### `hook`

```bash
zn-gate hook <agent>
```

The entry point the agents call. It reads one event as JSON on standard input and answers on standard output. You do not run it yourself. Exit codes: `0` allowed, `2` blocked (or an event it cannot read), `1` unknown agent.

### `secrets-mcp`

```bash
zn-gate secrets-mcp [--agent <id>]
```

Runs the `secrets` MCP server over standard input and output. Agents start it from their config; it never returns a secret value.

## MCP servers

### `mcp`

```bash
zn-gate mcp
```

Runs zn-gate as an MCP server (stdio) with the tools `analyze_prompt`, `check_tool_call` and `check_tool_result`.

### `shield`

```bash
zn-gate shield -- <command> [args...]
```

Wraps any external MCP server and checks its traffic. Example: `zn-gate shield -- uvx mcp-server-fetch`. Exit code `1` when no command is given, or when the program cannot be started (it is not installed, not on your `PATH`, or not executable); in that case it prints which program is missing and how to install it. Otherwise it ends when the wrapped server ends.

Aliases: `mcp-shield`, `wrap`.

## Logs and reports

### `evidence`

```bash
zn-gate evidence [--verify] [--ui [--port 3100]] [--export [--format jsonl|csv] [--output file]] [--tail 20]
```

Shows the local hash-chained log of what zn-gate decided. With no option it prints the counts and the last records (`--tail N`, default 20).

- `--verify`: check the SHA-256 chain. Exit `1` if it was changed.
- `--ui`: open a local dashboard in your browser (default port 3100).
- `--export`: write the records as `jsonl` (default) or `csv` to the screen or to `--output`.

Aliases: `logs`, `export`.

`export` is the same as `evidence --export`.

### `stats`

```bash
zn-gate stats [--days 30] [--json]
zn-gate stats share on|off|status|show
```

What zn-gate did on this machine: local counts for the last `--days` days (1 to 90, default 30). Exit codes: `0` done, `2` wrong usage.

#### `stats share`

Controls the optional sharing of pseudonymous daily counts. It is off by default. Only you can turn it on, in your own terminal. Without a word after `share` it shows the status.

#### `stats share on`

Explains what would be shared and asks you to confirm. Exit `1` if you do not confirm.

#### `stats share off`

Turns sharing off.

#### `stats share status`

Says whether sharing is on.

#### `stats share show`

Shows exactly what would be sent, and where.

### `report`

```bash
zn-gate report [--since 7d] [--json] [--no-team-line]
```

A short summary of the last days (`--since 1d` to `90d`, default 7): blocked actions, secrets hidden, new protected MCP servers and tool changes waiting for approval. It is built from local files and nothing is sent. [What it shows](report.md). Exit codes: `0` done, `2` wrong usage.

## Cloud check

### `connect`

```bash
zn-gate connect [--reconnect]
```

Optional. Opens usezn.com so you can create an analysis-only API key, then asks you to paste it at a hidden prompt. The key is kept in your system keychain or the zn vault, never in a file, and never accepted as an argument. [How it works](connect.md). Exit codes: `0` connected, `1` it could not be done (for example no terminal), `2` wrong usage.

### `disconnect`

```bash
zn-gate disconnect [--revoke | --no-revoke]
```

Removes the key from this computer and asks whether to revoke it on usezn.com too (default no). `--revoke` and `--no-revoke` answer for you. Exit codes: `0` done, `1` it could not be done, `2` wrong usage.

## zn Team

Needs the vault unlocked. Joining and leaving are confirmed outside the agent. [Details](team.md).

### `team`

```bash
zn-gate team <join|status|sync|leave|managed-config>
```

With no subcommand it is the same as `team status`. Exit codes: `0` done, `1` an error, `2` wrong usage.

#### `team join`

```bash
zn-gate team join <token> [--api https://api.example.com] [--agent claude-code]
```

Connects this machine to your organization with the join token your admin gave you.

#### `team status`

```bash
zn-gate team status [--json]
```

Shows the organization, the policy version and the state of the audit upload.

#### `team sync`

Downloads the policy and uploads the audit log now. Exit `1` when the policy is rejected or the machine was removed.

#### `team leave`

Disconnects this machine from the organization.

#### `team managed-config`

```bash
zn-gate team managed-config [--agent claude-code|cursor|codex|all] [--os macos|linux|windows|all] [--managed-hooks-only] [--exclusive-mcp] [--json]
```

For administrators. Prints the managed configuration files you deploy with MDM or configuration management so that the zn hooks run for every developer. Nothing is written and nothing is read from the machine. `--agent` defaults to `all` and `--os` to this computer's system. `--managed-hooks-only` makes the agent run only managed hooks. `--exclusive-mcp` also prints the managed MCP file for Claude Code (it takes exclusive control of MCP servers). `--json` prints the files as JSON. zn-gate must be installed on each machine. Exit codes: `0` done, `2` wrong usage.
