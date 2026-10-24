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

Without options, `init` is the guided setup: it finds the coding agents on this machine (Claude Code, Codex CLI, Cursor, OpenCode, Antigravity, ZCode desktop app), shows what is missing and, in your own terminal, asks before each step. It takes no other arguments. When it runs without a terminal, or an AI agent runs it, it only prints the steps and changes nothing.

With `--wrap-mcp` it finds the MCP servers in known agent configs and wraps them with `shield`. Backups are written first.

- `--dry-run`: show what would change, change nothing.
- `--shadow`: wrap in shadow mode: problems are logged but nothing is dropped.
- `--revert`: put back the MCP configs saved before zn wrapped them. It does not remove the Claude Code plugin, hooks or markers in `.env` files: for those run [`uninstall`](#uninstall).

`--dry-run`, `--shadow` and `--revert` each select `--wrap-mcp` too.

Exit codes: `0` done, or every agent found is already protected. `1` no supported agent found, or the steps were only printed. `2` an argument it does not know.

### `uninstall`

```bash
zn-gate uninstall [--dry-run]
```

Removes zn-gate from this computer in one step. It finds what is set up, prints the plan (each agent, with the file paths), and asks you to confirm in your own terminal, the same way `hooks install` does. Then it removes:

- the zn-gate plugin of Claude Code (with `claude plugin uninstall zn-gate@usezn`; without a `claude` command it prints the `/plugin` command to type);
- zn's hooks of every agent, for your user and for the current project, and zn's own `secrets` MCP server (the same as `hooks uninstall`);
- MCP servers wrapped by `init --wrap-mcp`: the saved copy of each config is put back (changes made to that file since are lost). Afterwards it looks again and lists any server that is still wrapped (for example a config wrapped twice) with what to do by hand.

The vault is not touched unless you answer yes to a second, separate question (default no); deleting it cannot be undone. `.env` files that hold zn markers are left alone, because the values are in the vault: run `zn env unshadow` first if you want them back in the file. It ends by running `check` and showing its result, and tells you how to remove the program itself (`npm uninstall -g zn-gate`).

- `--dry-run`: print the plan and change nothing.

Exit codes: `0` everything listed was removed, or there was nothing to remove. `1` you answered no, or a step failed (hooks, plugin, a wrapped MCP config, or the vault you asked to delete): what is left is printed with what to do by hand. `64` an option it does not know. `77` there is no interactive terminal, or an AI agent ran it: nothing was changed.

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

### `connect`

```bash
zn-gate connect [--reconnect]
```

Turns on the optional cloud check. It opens usezn.com/connect in your browser, where you create an analysis-only API key, then asks you to paste the key at a hidden prompt. zn-gate checks the key once with usezn.com and keeps it in your system keychain, or in the zn vault when there is no keychain, never in a plain file. It needs a person at a terminal: it refuses when an AI agent runs it or when there is no terminal. Never pass the key on the command line.

If you are already connected, it says so and changes nothing. `--reconnect` replaces the saved key.

Problems are printed on the error output, in plain words with one next step. If usezn.com cannot be reached (no internet connection) or is not answering, nothing is saved and the message tells you to check your connection or try again in a few minutes. If a setting of your terminal could change how the key travels (for example `NODE_OPTIONS`), the message names it and says how to remove it. If the computer has no system keychain and the vault is locked, the message tells you to run `unlock` first and then `connect` again.

Exit codes: `0` connected (or already connected), `1` nothing was saved (you said no, cancelled, the key was not accepted, the key could not be checked or stored, or there is no terminal), `2` the command was used wrongly (an option it does not know, or the key on the command line).

### `disconnect`

```bash
zn-gate disconnect [--revoke | --no-revoke]
```

Turns the cloud check off and removes the saved key from this computer. Unless you pass an option, it asks whether to revoke the key on usezn.com too, so it stops working everywhere. `--revoke` revokes without asking; `--no-revoke` only removes the local copy. It needs a person at a terminal and removes and revokes nothing without one.

It always removes zn's own connect setting, so `connect` no longer says you are connected. If the system keychain cannot be reached, zn says so, and tells you to delete the item named `zn-cloud` in your keychain app and to revoke the key at usezn.com/api-keys. That case still exits `0`. If the key is kept in the zn vault and the vault is locked, nothing is removed: unlock the vault and run the command again.

Exit codes: `0` the local setting was removed (or there was nothing to remove), `1` something was not done (no terminal, the vault is locked, a revoke you asked for did not happen), `2` the command was used wrongly.

## Scan and review

### `scan`

```bash
zn-gate scan [path] [--format text|json|github] [--all] [--include .rst,.xml] [--exclude fixtures,legacy] [--include-home] [--allow-partial]
```

Looks through prompt templates, markdown, skills and configs for injection traps and secrets. `path` defaults to the current folder. Matched values are never printed.

- `--format`: `text` (default), `json`, or `github` (workflow annotations for CI).
- `--all` (or `--code`): include source code files.
- `--include`: more file extensions to scan.
- `--exclude`: more folders to skip.
- `--include-home`: also check your own MCP configs for passwords and keys written in plain text.
- `--allow-partial`: exit `0` even when some files or folders were not read. They are still listed in the report. It does not apply when no file was read at all. In the Node version, put the path before the options (`scan ./docs --allow-partial`): `scan --allow-partial ./docs` scans the current folder.

Exit codes: `0` nothing found and everything that matched was read, `1` something was found or the path does not exist, `2` an unknown `--format`, `3` the coverage is incomplete: no file was read, or a file or folder that should have been read was not. Findings win: when something was found the exit code is `1`, whether or not anything was skipped.

A scan never reports a clean result for something it could not read. A folder it cannot open is listed under "Directories not scanned" (reason: cannot be read), in `skipped_dirs` for `--format json` and as a notice for `--format github`. If no file was read at all, the output says "No files were scanned" (a `warning` field in JSON) and the text report shows `NOTHING SCANNED` instead of `PASSED`. The exit code is `3` in that case, so a CI job cannot pass on a scan that looked at nothing; a path that does not exist exits `1`. The same exit code `3` applies when a file was skipped (2 MiB or larger, cannot be read, not a regular file, or a binary `.key` file) or a folder could not be opened, because the result does not cover everything that matched. Folders skipped by name (such as `node_modules`) do not count. Links found inside the folder are not followed and are not listed. Pass `--allow-partial` to accept skipped files and folders (exit `0`, still listed; `--format json` has `"incomplete": true`). Python also has `--no-fail`, which always exits `0`. The Node (`npx zn-gate`) and Python (`pip install zn-gate`) versions give the same exit codes and the same JSON fields (`skipped_dirs`, `warning`) for these cases; the text report differs in its wording and in how it prints paths.

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
SERVER='paste-the-server-name-here'
zn-gate pins approve "$SERVER"
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

```text
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

Removes a secret, together with the first-use approvals it had. A new value stored under the same name asks for approval again.

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

Approves the first use of a secret by a command that is already allowed. It is confirmed in the vault prompt. An approval belongs to the value it was given for: if you remove the secret or store a different value under the same name, zn asks again.

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

```text
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

Puts the original values back into the file from the encrypted copy that `env shadow` printed. The plain text leaves the vault only after you confirm in the vault's own prompt (a system dialog, or the `zn unlock --foreground` terminal), as for the first use of a command.

### `run`

```text
zn-gate run [--secrets NAME[,NAME...]] [--agent ID] -- <command> [args...]
```

Runs a command with markers replaced by real values, only for commands you allowed, and masks the values in its output. Everything after `--` belongs to your command. `-s` is short for `--secrets`.

Exit codes: the exit code of your command; `64` wrong usage, `77` refused (not allowed or not approved), `127` the program was not found, `1` another error.

### `unlock`

```bash
zn-gate unlock [--ttl 8h] [--idle 30m] [--backend name] [--passphrase-stdin] [--foreground]
```

Unlocks the vault for this session. The first run creates it. `--ttl` and `--idle` take a number with `s`, `m` or `h` (between 1 minute and 24 hours). `--passphrase-stdin` reads the passphrase from a pipe when there is no system keychain. `--foreground` keeps the vault in this terminal and asks for confirmations here. It refuses to run under an AI agent. It says when the vault locks again: after the `--idle` time with no use, or at the end of the session at the latest, in your local time with the hours left, for example `Vault unlocked: locks after 30 min idle, or at 23:09 (in 8 h) at the latest.`

If the system keychain refuses, zn says which one (macOS Keychain, Windows Credential Manager or the Linux keyring) and what to do: allow zn in the keychain window, check Credential Manager, unlock your keyring, or create the vault with a passphrase instead.

Exit codes: `0` unlocked, `1` an error (for example the vault could not be opened), `2` the command was used wrongly: an option it does not know, an option without its value, an extra word, a `--ttl` or `--idle` that is not a duration between 1 minute and 24 hours, or a `--backend` it does not know. Nothing is done in that case.

### `lock`

```bash
zn-gate lock
```

Locks the vault now. Exit codes: `0` done (also when the vault was not unlocked), `2` the command was used wrongly (it takes no options or words).

### `vault`

```text
zn-gate vault <status|log|verify|forget|team|reset|purge>
```

With no subcommand it is the same as `vault status`. Usage errors exit `2`: an unknown subcommand, or an option or word the subcommand does not take.

#### `vault status`

Shows whether the vault exists and is unlocked and, when it is, when it locks: after the idle time with no use, or at the end of the session at the latest (in your local time). Exit codes: `0` done, `2` wrong usage.

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

Checks the chain and signatures of the audit log. If the check fails, it says at which record, tells you not to delete or edit the log, and links the troubleshooting page. Exit codes: `0` correct, `1` broken, `2` wrong usage.

#### `vault forget`

```bash
zn-gate vault forget [dir]
```

Forgets the token map of a project (default: the current folder). The vault must be locked: otherwise it exits `1`. Wrong usage (an option, or more than one folder) exits `2`.

#### `vault reset`

```bash
zn-gate vault reset
```

The way out when you lost the vault passphrase. It sets the old vault aside in a backup folder (`~/.zn/vault-backup-<date>`, still encrypted) and starts again with a new, empty vault the next time you run `unlock`. The values stored in the old vault are lost: nobody can read them without the old passphrase. It needs a person at a terminal, the vault must be locked, and you confirm by typing a phrase. It refuses on a machine that belongs to a zn Team organization. It never deletes the backup: to delete backups, use [`vault purge`](#vault-purge). Exit codes: `0` done (or there was no vault), `1` refused or cancelled, `2` wrong usage.

#### `vault purge`

```bash
zn-gate vault purge [--yes]
```

Deletes the vault for good, with everything that can open or rebuild it. It first lists every file it will delete: the vault (secrets and first-use approvals), the token maps of your projects, the audit log, every `vault-backup-*` folder made by `vault reset`, and the session key, plus the vault key in your system keychain. Then you confirm by typing `purge my vault`, and it deletes them and checks again that none is left. If a file or the keychain entry cannot be removed, it says which one and exits `1`; it never reports the vault as purged while something remains. The vault must be locked, and it refuses on a machine that belongs to a zn Team organization. It needs a person at a terminal; a script can pass `--yes` to skip the typed phrase and the terminal, but an AI agent can never run it. Deleting cannot be undone. Exit codes: `0` purged (or there was no vault), `1` refused, cancelled or not fully purged, `2` wrong usage.

#### `vault team`

Prints that a shared team vault is planned and not available, and counts the request on this machine only (see `stats`). Nothing is sent.

### `hooks`

```text
zn-gate hooks install <agent> [--project] [--no-mcp]
zn-gate hooks uninstall <agent> [--project] [--no-mcp]
```

Adds or removes the zn hooks of a coding agent (to remove zn-gate completely, use [`uninstall`](#uninstall)). `<agent>` is `claude-code`, `codex`, `cursor`, `opencode`, `antigravity`, `gemini` or `copilot` (`claude` is accepted for `claude-code`, `gemini-cli` for `gemini`). `--project` changes the settings of the current project instead of your user settings. `--no-mcp` leaves the `secrets` MCP server out. It needs an interactive terminal. An agent that is not in that list or a misspelled name is refused first, with the supported names, and exit code 64.

#### `hooks install`

Adds the hooks, and the `secrets` MCP server unless `--no-mcp` is given. A backup of the settings is written first. With `--project`, the shared files run `zn` from the PATH rather than a path on your machine, so everyone who uses the project needs zn-gate installed globally; the install prints a note when `zn` is not on your PATH.

#### `hooks uninstall`

Removes them again. The small launcher script under `~/.zn/hooks` is shared by every profile of the same agent on your machine (for example two Claude Code profiles with different `CLAUDE_CONFIG_DIR` folders), so `hooks uninstall` leaves it in place: deleting it would stop the hooks of the other profiles. [`uninstall`](#uninstall) removes it, and `zn-gate check` reports a hook whose launcher is missing.

### `hook`

```text
zn-gate hook <agent>
```

The entry point the agents call. It reads one event as JSON on standard input and answers on standard output. You do not run it yourself. Exit codes: `0` allowed, `2` blocked (or an event it cannot read), `1` unknown agent.

### `secrets-mcp`

```text
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

```text
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

`zn-gate connect` turns the optional cloud check on and `zn-gate disconnect` turns it off: see [`connect`](#connect) and [`disconnect`](#disconnect) above, and [How it works](connect.md).

## zn Team

Needs the vault unlocked. Joining and leaving are confirmed outside the agent. [Details](team.md).

### `team`

```text
zn-gate team <join|status|sync|leave|managed-config>
```

With no subcommand it is the same as `team status`. Exit codes: `0` done, `1` an error, `2` wrong usage.

#### `team join`

```bash
JOIN_TOKEN='paste-your-join-token-here'
zn-gate team join "$JOIN_TOKEN"
# Optional: add --api https://api.example.com (another server), --agent claude-code,
# or --include-history to also send the audit records written before you joined
```

Connects this machine to your organization with the join token your admin gave you. It exits `0` only after the organization's first valid policy has been downloaded and applied. If that fails (offline, or no policy published yet) it exits `1`; the machine stays registered, `team status` shows the join as pending, and `team sync` finishes it. Only the audit records written from the join on are uploaded; `--include-history` adds the earlier ones, and only at the first join of an installation.

#### `team status`

```bash
zn-gate team status [--json]
```

Shows the organization, the policy version, what the last policy version removed or loosened, the state of the audit upload, and a revocation that is still pending after `team leave`. See [zn Team](team.md#when-the-organization-lifts-a-restriction).

#### `team sync`

Downloads the policy and uploads the audit log now. Exit `0` only when a valid policy is applied and no upload failed. Exit `1` when the machine is offline, the organization has no policy, the policy is refused, the machine was removed, or an upload failed; `team status` keeps the last reason. A sync that was running when you left the organization, or joined another one, is dropped and writes nothing.

#### `team leave`

Disconnects this machine from the organization. It first tells the server to revoke this installation (with the installation's own token), then deletes the local copies of the policy and upload state. Exit `1` when one of those files cannot be deleted; the message names it. If the server cannot take the revocation now (offline, an error, a rate limit, or an older server), the machine still leaves at once and the command exits `0`, but it prints that the server was not told yet: zn-gate keeps the token in the vault only to retry on `team sync` and while the vault is unlocked, for up to 30 days, and `team status` shows the pending revocation. See [zn Team](team.md#leaving).

#### `team managed-config`

```bash
zn-gate team managed-config [--agent claude-code|cursor|codex|all] [--os macos|linux|windows|all] [--managed-hooks-only] [--exclusive-mcp] [--json]
```

For administrators. Prints the managed configuration files you deploy with MDM or configuration management so that the zn hooks run for every developer. Nothing is written and nothing is read from the machine. `--agent` defaults to `all` and `--os` to this computer's system. `--managed-hooks-only` makes the agent run only managed hooks. `--exclusive-mcp` also prints the managed MCP file for Claude Code (it takes exclusive control of MCP servers). `--json` prints the files as JSON. zn-gate must be installed on each machine. Exit codes: `0` done, `2` wrong usage.
