# Command line reference

Every command of the `zn-gate` program, with its options and exit codes. For a first walk through, start with [First 5 minutes](first-5-minutes.md). Words you do not know are explained in the [glossary](glossary.md).

## Contents

- [`init`](#init)
- [`uninstall`](#uninstall)
- [`check`](#check)
- [`status`](#status)
- [`test`](#test)
- [`version`](#version)
- [`connect`](#connect)
- [`disconnect`](#disconnect)
- [`scan`](#scan)
- [`audit`](#audit)
- [`reach`](#reach)
- [`analyze`](#analyze)
- [`pins`](#pins)
- [`secret`](#secret)
- [`env`](#env)
- [`run`](#run)
- [`unlock`](#unlock)
- [`lock`](#lock)
- [`vault`](#vault)
- [`hooks`](#hooks)
- [`hook`](#hook)
- [`secrets-mcp`](#secrets-mcp)
- [`mcp`](#mcp)
- [`shield`](#shield)
- [`evidence`](#evidence)
- [`why`](#why)
- [`stats`](#stats)
- [`report`](#report)
- [`team`](#team)

## Program names

The package installs three names. They are the same program, so every command below works with any of them:

- `zn-gate`
- `zn`
- `zn-mcp`

Without installing, use `npx -y zn-gate <command>`. This page writes `zn-gate` in examples.

This page describes the npm package. The Python package (`pip install zn-gate`) has a smaller command line: see [The Python package](#the-python-package) at the end.

`zn-gate --help` (or `-h`) prints the short help. `zn-gate version`, `zn-gate -v`, `zn-gate -V` and `zn-gate --version` print the version.

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

### Settings at a glance

| Setting | Default | What it changes |
|---|---|---|
| `ZN_API_KEY` or `--key <api_key>` | Not stated | API key for the optional cloud check (`analyze`, `analyze_prompt`). |
| `ZN_CLOUD=1` | Off: nothing leaves your machine | Turns the optional cloud check on. |
| `ZN_LOCAL_ONLY=true` or `--local-only` | Not stated | Never uses the cloud, even when `ZN_CLOUD=1` is set. |
| `ZN_STAGE` or `--stage <v30\|prod>` | `v30` | Cloud stage. |
| `ZN_API_URL` or `--url <url>` | Not stated | Uses another cloud address. |
| `--long-input <windows\|off>` | `windows` (overlapping windows, up to 20) | How long texts are sent to the cloud check; `off` sends only the first 512 tokens. |
| `ZN_STATS=off` | Not stated | Turns off the local counts shown by `stats` and `report`. |
| `ZN_VERBOSE=1` or `--verbose` | Not stated | Prints debug messages to the error output. |
| `NO_COLOR` | Not stated | Turns off colors. |

The table below gives the full description of each setting.

| Setting | Effect |
|---|---|
| `ZN_API_KEY` or `--key <api_key>` | API key for the optional cloud check. Used only by `analyze` and `analyze_prompt`, and only when the cloud check is on. |
| `ZN_CLOUD=1` | Turns the optional cloud check on. Without it (or `zn-gate connect`) nothing leaves your machine. |
| `ZN_LOCAL_ONLY=true` or `--local-only` | Never use the cloud, even when `ZN_CLOUD=1` is set. |
| `ZN_STAGE` or `--stage <v30\|prod>` | Cloud stage. Default `v30`. |
| `ZN_API_URL` or `--url <url>` | Use another cloud address. |
| `--long-input <windows\|off>` | How long texts are sent to the cloud check: in overlapping windows (default, up to 20), or only the first 512 tokens. Any other value exits `2`. |
| `ZN_TEAM_JOIN_TOKEN` | The join token for `team join` when you give none as an argument and no `-`. Keeps the token out of your shell history. An argument wins over it. |
| `ZN_STATS=off` | Turns off the local counts shown by `stats` and `report`. |
| `ZN_VERBOSE=1` or `--verbose` | Prints debug messages to the error output. |
| `NO_COLOR` | Turns off colors, emoji and box-drawing characters. Any non-empty value counts (see [no-color.org](https://no-color.org)). `TERM=dumb` does the same. |
| `CI` | Any non-empty value turns off emoji and box-drawing characters too. Colors are not affected. |

Emoji and box-drawing characters are used only when the output goes to a terminal and neither `NO_COLOR`, `TERM=dumb` nor `CI` is set. Everywhere else the CLI prints a short ASCII marker in their place: `[ok]` for a check mark, `[!]` for a warning, `[x]` for a failure, `[+]` for the shield, and `->` for an arrow. Rules are drawn with dashes. So output sent to a pipe or a file is plain printable ASCII, apart from text that comes from your own files or input. The status words (`ALLOWED`, `BLOCKED`, `FAILED`, ...) carry the meaning in every mode.

### All environment variables

Every `ZN_` variable you can set, with its default and the package that reads it. "Both" means the npm and the Python package read it the same way. Not listed: variables that zn sets for its own helper processes (for example `ZN_HOOK_ACK` and `ZN_HOOK_VAULT_WAIT_MS`), the names passed to the Windows helper scripts, and the test-only switches. You never need to set those.

| Variable | Default | What it does | Package |
|---|---|---|---|
| `ZN_HOME` | `~/.zn` | Folder for zn's own files: stats, the evidence log, pins and hook launchers. | Both |
| `ZN_CLOUD=1` | Off | Turns the optional cloud check on. | Both |
| `ZN_API_KEY` | None | API key for the cloud check. Used only when the cloud check is on. | Both |
| `ZN_LOCAL_ONLY=true` | Off | Never uses the cloud, even when `ZN_CLOUD=1` is set. | Both |
| `ZN_API_URL` | The address of `ZN_STAGE` | Uses another cloud address. Ignored for a key saved by `zn-gate connect`, which only ever goes to the zn API address. | Both |
| `ZN_STAGE` | The production API | Which cloud API route the check is sent to: `prod`, or unset for the default route. Any other value also uses the default route. Leave it unset unless you were told to change it. `zn-gate --help` lists the accepted values under `--stage`. | Both |
| `ZN_LONG_INPUT` | `windows` | How long texts are sent to the cloud check. `windows` sends overlapping windows of the text; `off` sends only the start. The values `none`, `truncate`, `0`, `false` and `no` also count as `off`. Any other value counts as `windows`. | Both |
| `ZN_STRICT=1` | Off | Treats advisory rules as blocking. The environment can only add strictness. | Both |
| `ZN_ALLOW_TRUNCATED=1` | Off | Lets through output too large to scan in full. It is still marked as truncated. By default such output is blocked. | Both |
| `ZN_BLOCK_TRUNCATED=1` | Off | Blocks output too large to scan in full, even when `ZN_ALLOW_TRUNCATED=1` is set. | Both |
| `ZN_VERBOSE=1` | Off | Shows technical details of errors. `DEBUG=zn` does the same. | Both |
| `ZN_STATS=off` | On | Turns off the local counts shown by `stats` and `report`. | npm |
| `ZN_BLOCK_DESTRUCTIVE=1` | Two rules on (`rm_root_home`, `disk_overwrite`) | `1` turns on all six destructive-command rules. | npm |
| `ZN_HOOK_FAIL_MODE=closed` | `closed` | Makes hooks fail closed, which is the default. `open` set here is ignored. It is read only from the config file: `hooks.whenUnavailable` set to `allow` in `~/.zn/config.json` in your operating-system account's home folder. A `config.json` in the folder `ZN_HOME` (or `HOME`) points to can only add protection: settings that turn a check off or turn on a network lookup are not read from there. | npm |
| `ZN_EGRESS_CHECK` | `ask` (or the config value) | `deny` makes the outbound-network check deny instead of ask. The environment can only raise the level. | npm |
| `ZN_PACKAGE_CHECK=offline` | The config value | Turns on offline mode for the check on newly seen packages. `1` does the same. The environment can only add offline mode: `online` is read as offline. | npm |
| `ZN_MCP_PINNING` | The config value (`mcpPinning`), or `warn` when unset | Pinning mode for MCP servers. The stricter of this and the config value applies. | npm |
| `ZN_SHIELD_LIMITS` | The built-in limits | A JSON object that lowers the shield's size and count limits, for tests and unusual setups. Values above a built-in limit are cut to it; values that are not positive whole numbers are ignored. | npm |
| `ZN_HOOK_DIR` | `~/.zn/hooks` (`$ZN_HOME/hooks` when `ZN_HOME` is set) | Folder for the hook launchers. It must be private to your user. | npm |
| `ZN_AGENT` | None | Agent name for `zn run` and the MCP server when `--agent` is not given. | npm |
| `ZN_TEAM_JOIN_TOKEN` | None | Join token for `team join` when no token is given as an argument. An argument wins. | npm |
| `ZN_KEYCHAIN_BACKEND` | Detected | Forces the system keychain backend. For tests and unusual setups. | npm |
| `ZN_KEYCHAIN_SERVICE` | `zn-vault` | Service name used in the keychain. For tests and unusual setups. | npm |
| `ZN_KEYCHAIN_PATH` | The system default | On macOS, the keychain file to use. For tests and unusual setups. | npm |
| `ZN_NO_COMPILE_CACHE` | Off | Any value turns off the Node.js compile cache. | npm |
| `ZN_NPM_REGISTRY` | `https://registry.npmjs.org` | Registry that `zn-gate scan --package` downloads from. Must be an https address; plain http is accepted for localhost only. | npm |

## Set up and check

### `init`

```bash
zn-gate init
zn-gate init --wrap-mcp [--dry-run] [--shadow] [--revert]
```

Without options, `init` is the guided setup: it finds the coding agents on this machine (Claude Code, Codex CLI, Cursor, OpenCode, Antigravity, ZCode desktop app, GitHub Copilot, and the experimental Gemini CLI), shows what is missing and, in your own terminal, asks before each step. It takes no other arguments. When it runs without a terminal, or an AI agent runs it, it only prints the steps and changes nothing.

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
- the OpenCode plugin that zn wrote, for your user and for the current project (any other plugin in the same folder stays);
- zn's hook launcher scripts in `~/.zn/hooks` (only the files zn wrote), and that folder when it is empty;
- MCP servers wrapped by `init --wrap-mcp`: the saved copy of each config is put back (changes made to that file since are lost). Afterwards it looks again and lists any server that is still wrapped (for example a config wrapped twice) with what to do by hand.

The vault is not touched unless you answer yes to a second, separate question (default no); deleting it cannot be undone. `.env` files that hold zn markers are left alone, because the values are in the vault: run `zn env unshadow` first if you want them back in the file. It ends by running `check` and showing its result, and tells you how to remove the program itself (`npm uninstall -g zn-gate`), which is the last step: wrapped MCP servers are put back first, then the hooks and the plugin go, so no agent is left pointing at a missing command.

- `--dry-run`: print the plan and change nothing.

Exit codes: `0` everything listed was removed, or there was nothing to remove. `1` you answered no, or a step failed (hooks, plugin, a wrapped MCP config, or the vault you asked to delete): what is left is printed with what to do by hand. `64` an option it does not know. `77` there is no interactive terminal, or an AI agent ran it: nothing was changed.

### `check`

```bash
zn-gate check
```

Shows that zn stops your agent from reading a fake secret, in a temporary folder. zn-gate sends nothing over the network and no setting changes. It runs the installed zn hooks on two test requests, and the only agent program it starts is `<agent> --version` for each agent it finds, to read the version, with no tokens and with updates turned off. It ends with the decision time per tool call (p50 and p95 of the last 100 calls on this machine; excludes process startup, writing the response, and saving stats and evidence), or `no data yet` before zn has checked one. [What the output means](check.md).

Aliases: `doctor`.

Exit codes: `0` every agent that is set up is protected. `1` an agent is not protected, or none is set up. On a new machine, set zn up first (`zn-gate init`); until an agent is set up, `check` exits with `1`. An option it does not know (for example `--verbose`) exits with `2`, names it and lists the options that `check` takes (`--hooks` and `--json`).

```bash
zn-gate check --hooks
```

Lists every installed zn hook (agent, settings file, event and the command it runs) and says whether each is OK, stale (written by an older zn-gate) or broken, with the command that fixes it. It only reads files: nothing is run, changed or sent. Exit code `0` when every hook is OK, `1` when any is stale or broken. [What the output means](check.md#list-every-installed-hook).

```bash
zn-gate check --json
```

Prints the same check as one JSON object, for scripts, CI and support requests. Same exit codes; your home folder is shown as `~`. [Fields](check.md#machine-readable-output).

### `status`

```bash
zn-gate status
```

Shows the version, the rules version, whether the optional cloud check is on and where the API key comes from. If any installed hook was written by an older zn-gate, it also prints one warning naming each agent and the command that refreshes it (`zn hooks install <agent>`, with `--project` for project hooks); it prints nothing about hooks when they are all current. It only reads files: nothing is run, changed or sent. Always exits `0`.

### `test`

```bash
zn-gate test
```

Runs the local self-test on built-in examples (attacks and ordinary developer text). It never uses the network. Exit codes: `0` all passed, `1` at least one example failed.

### `version`

```bash
zn-gate version
```

Prints the version and the versions of the rules. Exit code `0`. `-v`, `-V` and `--version` do the same.

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
zn-gate scan --package <name>[@version]
```

Looks through prompt templates, markdown, skills and configs for injection traps and secrets. `path` defaults to the current folder. Matched values are never printed.

- `--format`: `text` (default), `json`, or `github` (workflow annotations for CI).
- `--all` (or `--code`): include source code files.
- `--include`: more file extensions to scan.
- `--exclude`: more folders to skip.
- `--include-home`: also check your own MCP configs for passwords and keys written in plain text.
- `--package <name>[@version]`: audit an npm MCP server or skill before you add it. The package is downloaded from the registry (`ZN_NPM_REGISTRY`, or npmjs.org), checked against the checksum the registry gave, unpacked to a temporary folder, and its files with a scanned extension are read (see below for what is not). No folder is skipped by name: `node_modules`, `dist` and `build` inside the package are scanned too, with source files (`.js`, `.mjs`, `.cjs`, `.ts`, `.tsx` and the other extensions of a normal scan with `--code`). The agent-config audit (see [`audit`](#audit)) runs on it too, also without skipping folders. Nothing in the package is installed or run. Text output only for now; `--include-home`, `--allow-partial`, `--exclude` and a folder argument are refused (exit `2`).

  Before the result, the report lists what npm would run or add if you installed the package, read from its `package.json` (a note, not a finding: it does not change the exit code). The line `Install scripts (npm runs these when you install it)` shows its `preinstall`, `install` and `postinstall` scripts with their literal command, or says there are none. A `prepare` script is shown on its own line, because npm runs it only when a package is installed from git, not from the registry. A `binding.gyp` with no `preinstall` or `install` script is flagged, because npm then builds it with `node-gyp`. The `bin` entries are listed as `Commands it adds (bin)`. Read the commands before you run `npm install` or `npx` on the package.
- `--allow-partial`: exit `0` even when some files or folders were not read. They are still listed in the report. It does not apply when no file was read at all. In the Node version, put the path before the options (`scan ./docs --allow-partial`): `scan --allow-partial ./docs` scans the current folder.

Exit codes: `0` nothing found and everything that matched was read, `1` something was found or the path does not exist, `2` an unknown `--format`, `3` the coverage is incomplete: no file was read, or a file or folder that should have been read was not. Findings win: when something was found the exit code is `1`, whether or not anything was skipped.

With `--package`, exit `2` also means the package was not scanned: the registry could not be reached, the name or version is unknown, the answer is not JSON or is too large, the checksum does not match, the tarball address or a redirect leads away from the registry's own address (host and port, with the same https rule), or the tarball has a link, a special file or a path that leaves its folder. Nothing is scanned in those cases, and the message says why. A package is never reported as clean when part of it was not read: a file of 2 MiB or larger, a file that could not be unpacked, or a part the agent-config audit did not walk (it stopped at its time budget or entry limit, a folder could not be opened, or an agent file could not be fully checked) gives exit `3` and is named (findings still give `1`). On Windows, file names it cannot create (such as `NUL`, `CON` or a name with a colon) are not unpacked, so they are listed and give exit `3`.

What `--package` does not cover: it reads the files inside the package itself, not the packages it depends on (unless they are bundled inside it); files of other types (binaries, `.wasm`, files without a scanned extension) are not read; and it does not run the package, so it cannot see what the code does when it runs. If you interrupt a scan with Ctrl+C, the temporary folder (`zn-scan-pkg-` and a random suffix, in your system temporary folder) is left behind and can be deleted.

A scan never reports a clean result for something it could not read. A folder it cannot open is listed under "Directories not scanned" (reason: cannot be read), in `skipped_dirs` for `--format json` and as a notice for `--format github`. If no file was read at all, the output says "No files were scanned" (a `warning` field in JSON) and the text report shows `NOTHING SCANNED` instead of `PASSED`. The exit code is `3` in that case, so a CI job cannot pass on a scan that looked at nothing; a path that does not exist exits `1`. The same exit code `3` applies when a file was skipped (2 MiB or larger, cannot be read, not a regular file, or a binary `.key` file) or a folder could not be opened, because the result does not cover everything that matched. Folders skipped by name (such as `node_modules`) do not count (with `--package` nothing is skipped by name). Links found inside the folder are not followed and are not listed. Pass `--allow-partial` to accept skipped files and folders (exit `0`, still listed; `--format json` has `"incomplete": true`). Python also has `--no-fail`, which always exits `0`. The Node (`npx zn-gate`) and Python (`pip install zn-gate`) versions give the same exit codes and the same JSON fields (`skipped_dirs`, `warning`) for these cases; the text report differs in its wording and in how it prints paths.

### `audit`

```bash
zn-gate audit [path] [--format text|json|sarif] [--output file] [--fail-on high] [--agents claude,codex,all] [--include-home] [--approve]
```

Reviews the agent configs of a folder before you open it: hooks, MCP servers, endpoint overrides, permissions, instructions and planted programs. It runs nothing. [What it finds](audit.md).

- `--format`: `text` (default), `json` or `sarif`.
- `--output` (or `-o`): write the report to a file.
- `--fail-on`: `low`, `medium`, `high` (default), `critical` or `none`.
- `--agents`: a comma-separated list of `claude`, `codex`, `cursor`, `opencode`, `amazonq`, `copilot`, `gemini`, or `all` (default).
- `--include-home`: also review your own agent configs in your home folder.
- `--approve`: record the executable configuration of the project (MCP servers, hooks, permissions, helper commands and similar) as approved, then exit. Later audits report an entry that changed, was added or was removed since. It runs only at a terminal, not when an agent started it. Only entry names and hashes are stored, never a value. [Details](audit.md).

Exit codes: `0` nothing at or above `--fail-on`, `1` findings at or above it, `2` wrong usage or a path that is not a folder.

### `reach`

```bash
zn-gate reach [path] [--json | --sarif] [--fail-on high|medium|low|none] [--remember]
zn-gate reach --history [--json] [--max-seconds N]
```

Shows what your coding agents can reach from a folder: secrets (names only), credential files and MCP servers. Read only, nothing is sent. [What it shows](reach.md). With `--history` it instead scans the local session histories of Claude Code and Codex for secrets they kept, and prints agent, file, secret type, count and the action to take, never a value. [History](reach.md#history-did-your-agents-keep-a-secret-of-yours).

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

```bash
SERVER='paste-the-server-name-here'
zn-gate pins approve "$SERVER"
zn-gate pins approve --all
```

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

Lists the stored secrets: names and policy, never values. The vault must be unlocked first (`zn-gate unlock`); on a locked vault the command exits with an error.

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

```bash
zn-gate secret get API_TOKEN   # exits 77 and points you to `run`
```

There is no way to print a secret value: `secret get` exits `77` and points you to `run`, which uses the value without showing it.

Aliases: `secret reveal`.

### `env`

```text
zn-gate env <shadow|unshadow> ...
```

Groups the two commands below. Run `zn-gate env --help` for the short usage.

Exit codes (both commands): `0` done (also when there was nothing to move, or with `--dry-run`, or with `--help`), `1` an error (for example the file or the vault could not be read), or `env unshadow` when you answered no, `64` wrong usage (an unknown subcommand or option, or a missing or malformed `--backup`), `77` there is no interactive terminal, or an AI agent ran it: nothing was changed.

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
zn-gate run [--secrets NAME[,NAME...]] [--agent ID] [--egress-allow HOST[:PORT],...] -- <command> [args...]
```

Runs a command with markers replaced by real values, only for commands you allowed, and masks the values in its output. Everything after `--` belongs to your command. `-s` is short for `--secrets`.

- `--egress-allow HOST[:PORT],...`: off by default. The command can reach only those hosts over HTTP(S), through a local proxy that zn starts for the command. Other requests are refused and the refused host is logged, never the body. An entry without a port allows every port of that host. [Details and limits](secrets.md#egress-allowlist-for-zn-run).

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

```bash
zn-gate vault status
```

Shows whether the vault exists and is unlocked and, when it is, when it locks: after the idle time with no use, or at the end of the session at the latest (in your local time). Exit codes: `0` done, `2` wrong usage.

#### `vault log`

```bash
zn-gate vault log [--since 1h]
```

Shows the vault audit log of secret use. Same as `secret log`. With the vault unlocked, the vault checks the whole log first (every signature, the chain and the last record it remembers). If the check fails, the log is not shown: the command prints the reason, exits `1` and the vault stores a warning (see `vault verify`). With the vault locked the chain cannot be checked, and the output says so. Exit codes follow the secrets commands above.

#### `vault log export`

```bash
zn-gate vault log export --otlp [--since 7d] [--out file] [--unverified]
```

Writes the vault audit log as OpenTelemetry logs (OTLP, JSON Lines) to the file, or to the screen. Needs no account. With the vault unlocked, the vault checks the whole log first and nothing is exported when the check fails (exit `1`, and the vault stores a warning, see `vault verify`). With the vault locked the chain cannot be checked: the export is refused unless you add `--unverified`, and then it prints a warning that it is not a verified copy. `--out` writes a new private (0600) file and refuses a symbolic link or a folder. Exit codes: `0` done, `1` error, `2` without `--otlp`. [Details](team.md).

#### `vault verify`

```bash
zn-gate vault verify
```

Checks the chain and signatures of the vault audit log. If the check fails, it says at which record, tells you not to delete or edit the log, and links the troubleshooting page. The vault also compares the last record with the one it remembers, before it writes anything new. If the log was cut, replaced or changed in any record while the vault was locked or running, the check fails (a failed check stores the warning too), and keeps failing after lock and unlock, until you accept the log as it is now with `zn-gate vault verify --acknowledge` (run it yourself in a terminal: it refuses when an agent runs it, and the vault asks you to confirm in its own dialog or terminal). Accepting does not erase the gap: a warning record is written to the log. Exit codes: `0` correct, `1` broken, `2` wrong usage.

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

Deletes the vault for good, with everything that can open or rebuild it. It first lists every file it will delete: the vault (secrets and first-use approvals), the token maps of your projects, the vault audit log, every `vault-backup-*` folder made by `vault reset`, and the session key, plus the vault key in your system keychain. Then you confirm by typing `purge my vault`, and it deletes them and checks again that none is left. If a file or the keychain entry cannot be removed, it says which one and exits `1`; it never reports the vault as purged while something remains. The vault must be locked, and it refuses on a machine that belongs to a zn Team organization. It needs a person at a terminal; a script can pass `--yes` to skip the typed phrase and the terminal, but an AI agent can never run it. Deleting cannot be undone. Exit codes: `0` purged (or there was no vault), `1` refused, cancelled or not fully purged, `2` wrong usage.

#### `vault team`

```bash
zn-gate vault team
```

Prints that a shared team vault is planned and not available, and counts the request on this machine only (see `stats`). Nothing is sent.

### `hooks`

```text
zn-gate hooks install <agent> [--project] [--no-mcp]
zn-gate hooks uninstall <agent> [--project] [--no-mcp]
```

Adds or removes the zn hooks of a coding agent (to remove zn-gate completely, use [`uninstall`](#uninstall)). Remove the hooks before you remove the program with `npm uninstall -g zn-gate`. `<agent>` is `claude-code`, `codex`, `cursor`, `opencode`, `antigravity`, `zcode`, `gemini` or `copilot` (`claude` is accepted for `claude-code`, `gemini-cli` for `gemini`). `--project` changes the settings of the current project instead of your user settings. `--no-mcp` leaves the `secrets` MCP server out. It needs an interactive terminal. An agent that is not in that list or a misspelled name is refused first, with the supported names, and exit code 64.

#### `hooks install`

```bash
zn-gate hooks install claude-code --project
```

Adds the hooks, and the `secrets` MCP server unless `--no-mcp` is given. A backup of the settings is written first. With `--project`, the shared files run `zn` from the PATH rather than a path on your machine, so everyone who uses the project needs zn-gate installed globally; the install prints a note when `zn` is not on your PATH. For Claude Code, `--project` adds no MCP server (a shared `.mcp.json` could only name `zn`, looked up on the PATH): run `zn hooks install claude-code` for the `secrets` server, and a `secrets` entry that a 1.14.0 release candidate wrote to the project's `.mcp.json` is removed, with a backup.

#### `hooks uninstall`

```bash
zn-gate hooks uninstall claude-code --project
```

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

Runs zn-gate as an MCP server (stdio) with the tools `analyze_prompt`, `check_tool_call`, `check_tool_result` and `zn_status` (reports the detection engine, the rules version and whether anything leaves the computer).

Exit codes: it runs until its input is closed, then exits `0`.

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

### `why`

```bash
zn-gate why [<id>]
```

Explains, in plain words, one block from the local decision log. With no id it explains the last block; with an id it explains that record (the `id` field of a record from `zn-gate evidence --export`). It says what was stopped (the tool and the short preview the log already holds, with secrets removed), which rule fired, why that matters, and the one command you can run in your own terminal to go on, when such a command exists. For a rule that cannot be bypassed it says so and who decides.

The command only reads the log: it changes nothing and uses no network. If the log does not hold enough to explain a record, for example because no rule id was recorded, it says what is missing instead of guessing. Exit codes: `0` explained, `1` nothing to explain (no log, no block, an id that is not in the log, or a log that cannot be read), `2` wrong usage. A line of the log that cannot be read is skipped, and the output says how many.

### `stats`

```bash
zn-gate stats [--days 30] [--json]
zn-gate stats share on|off|status|show
```

What zn-gate did on this machine: local counts for the last `--days` days (1 to 90, default 30). Exit codes: `0` done, `2` wrong usage.

`stats` also prints a `Top rules` block: the five detector ids that matched most often, each with its count. It covers the last 7 days, or the last `--days` days when you pass `--days`. Only detector ids, the generic label `Built-in detector` and counts are shown, never values, paths or command text, and nothing new is stored. A line below the block names the most frequent id. The npm package adds `zn why`, which explains your last block. The Python package points to the [troubleshooting page](https://usezn.com/docs/zn-gate/troubleshooting/) instead, because `why` is only in the npm package. The block is left out when nothing matched in the window.

With `--json`, the output is one JSON object with the same counts and these extra fields:

- `top_rules`: the same five rules as a list of `{ "id", "name", "count" }`, highest count first, ties by id. It is `[]` when nothing matched. `name` is always the generic label `Built-in detector` for now; rule-specific names are not shown yet.
- `top_rules_days`: the window of `top_rules` in days (`7` unless you passed `--days`).
- `sharing`: `true` when sharing of pseudonymous daily counts is on.
- `sent_days`: the days whose counts were really uploaded during this run. It is `[]` when sharing is off or nothing was pending.
- `send_failed`: the number of days whose upload failed during this run. They are tried again the next time you run `stats`.

When sharing is on, `stats` sends each complete day (every day before today) that has not been sent yet. The text output prints `Shared pseudonymous counts for <day>.` only for the days in `sent_days`, and it prints `<n> day(s) could not be shared; they will be tried next time.` when `send_failed` is more than `0`.

#### `stats share`

```bash
zn-gate stats share
```

Controls the optional sharing of pseudonymous daily counts. It is off by default. Only you can turn it on, in your own terminal. Without a word after `share` it shows the status.

#### `stats share on`

```bash
zn-gate stats share on
```

Explains what would be shared and asks you to confirm. Exit `1` if you do not confirm.

#### `stats share off`

```bash
zn-gate stats share off
```

Turns sharing off.

#### `stats share status`

```bash
zn-gate stats share status
```

Says whether sharing is on.

#### `stats share show`

```bash
zn-gate stats share show
```

Shows exactly what would be sent, and where.

### `report`

```bash
zn-gate report [--since 7d] [--json] [--no-team-line]
```

A short summary of the last days (`--since 1d` to `90d`, default 7): blocked actions, secrets hidden, new protected MCP servers and tool changes waiting for approval. It is built from local files and nothing is sent. [What it shows](report.md). Exit codes: `0` done, `2` wrong usage.

### Related commands

- [`why`](#why): [Reading `zn why` after a blocked command](examples/why-blocked-walkthrough.md), [Allow a blocked action after `zn why`](examples/zn-why-allow-command.md) and [Why was this blocked?](why-was-this-blocked.md). It reads the log that [`evidence`](#evidence) shows.
- [`stats`](#stats): [Examples of stats and report](examples/stats-and-report.md), in particular [Top rules in stats](examples/stats-and-report.md#top-rules-in-stats). The optional sharing of daily counts is [`stats share`](#stats-share).
- [`report`](#report): [See what zn-gate did this week](report.md) and [the weekly report example](examples/stats-and-report.md#weekly-report). For the counts alone, use [`stats`](#stats).

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
zn-gate team join -
# Paste the join token and press Enter. Or set ZN_TEAM_JOIN_TOKEN and run: zn-gate team join
# Optional: add --api https://api.example.com (another server), --agent claude-code,
# or --include-history to also send the audit records written before you joined
```

The three forms: `zn team join <token>`, `zn team join -` and `ZN_TEAM_JOIN_TOKEN=... zn team join`. Where the join token comes from: an argument (`team join <token>`), standard input (`team join -`, reads one line) or the `ZN_TEAM_JOIN_TOKEN` environment variable. An argument wins over the environment variable; `-` means standard input. A token typed as an argument stays in your shell history and is visible in the process list, so zn prints a one-line note when you do that. The token is never printed.

Connects this machine to your organization with the join token your admin gave you. It exits `0` only after the organization's first valid policy has been downloaded and applied. If that fails (offline, the policy is refused, or no policy is published yet) it exits `1`; the machine stays registered, `team status` shows the join as pending, and `team sync` finishes it. If your admin has not published a policy yet, it says so and that this is expected: no restrictions apply until one exists, and zn checks again by itself. A join with no token, a token that is expired or already used, and no network each say what happened and the command to run next; the HTTP status or internal code is shown only with `ZN_VERBOSE=1`. Only the audit records written from the join on are uploaded; `--include-history` adds the earlier ones, and only at the first join of an installation.

#### `team status`

```bash
zn-gate team status [--json] [--rules]
```

Shows the organization, the policy version, what the last policy version removed or loosened, the state of the audit upload, and a revocation that is still pending after `team leave`. With `--rules` it also prints the rules of the active signed policy in plain words (version, key id, expiry, each rule), read from the saved copy and checked again with the pinned key, with no network call. A copy that does not verify or has expired prints no rules. `--json` adds a `rules` object. See [zn Team](team.md#when-the-organization-lifts-a-restriction).

#### `team sync`

```bash
zn-gate team sync
```

Downloads the policy and uploads the vault audit log now. Exit `0` only when a valid policy is applied and no upload failed. Exit `1` when the machine is offline, the organization has no policy, the policy is refused, the machine was removed, or an upload failed; `team status` keeps the last reason. A sync that was running when you left the organization, or joined another one, is dropped and writes nothing.

#### `team leave`

```bash
zn-gate team leave
```

Disconnects this machine from the organization. It first tells the server to revoke this installation (with the installation's own token), then deletes the local copies of the policy and upload state. Exit `1` when one of those files cannot be deleted; the message names it. If the server cannot take the revocation now (offline, an error, a rate limit, or an older server), the machine still leaves at once and the command exits `0`, but it prints that the server was not told yet: zn-gate keeps the token in the vault only to retry on `team sync` and while the vault is unlocked, for up to 30 days, and `team status` shows the pending revocation. See [zn Team](team.md#leaving).

#### `team managed-config`

```bash
zn-gate team managed-config [--agent claude-code|cursor|codex|all] [--os macos|linux|windows|all] [--managed-hooks-only] [--exclusive-mcp] [--json]
```

For administrators. Prints the managed configuration files you deploy with MDM or configuration management so that the zn hooks run for every developer. Nothing is written and nothing is read from the machine. `--agent` defaults to `all` and `--os` to this computer's system. `--managed-hooks-only` makes the agent run only managed hooks. `--exclusive-mcp` also prints the managed MCP file for Claude Code (it takes exclusive control of MCP servers). `--json` prints the files as JSON. zn-gate must be installed on each machine. Exit codes: `0` done, `2` wrong usage.

## The Python package

`pip install zn-gate` installs only the name `zn-gate` (not `zn` or `zn-mcp`). It is meant for agents you build yourself. It has seven commands. `zn-gate version`, `zn-gate -v`, `zn-gate -V` and `zn-gate --version` print the version and the rules version.

| Command | Options | What it does |
|---|---|---|
| `test "<text>"` | `--json` | Checks one piece of text against the rules. It does **not** run the self-test that `test` runs in the npm package. Exit `0` if nothing was flagged, `1` if the text was blocked or contains a secret. |
| `analyze "<text>"` | `--local-only`, `--key`, `--stage`, `--url`, `--long-input windows\|off`, `--json` | Checks a prompt and prints JSON (always; `--json` is the default). Exit `0` allowed, `2` blocked. Without a text (or with an empty one) it prints the usage and exits `2` (the npm package exits `1`). |
| `scan [path]` | `--format text\|json\|github`, `--no-fail`, `--allow-partial`, `--include`, `--exclude`, `--include-home` | Like `scan` in the npm package, without the `--all` and `--code` options. Exit `0` nothing found, `1` something was found or the path does not exist, `3` no file was read, or a file or folder could not be read (`--allow-partial` accepts the files it could not read; reading no file at all stays `3`). `--no-fail` always exits `0`. There is no `--package` in the Python version yet. |
| `evidence` | `--verify`, `--export`, `--format jsonl\|csv`, `--output file` | Counts, chain check and export, like the npm command. There is no `--ui`, no `--tail` and no `logs` or `export` alias. |
| `status` | none | Shows the version, the rules version, the Python version and whether the optional cloud check is on. Exit `0`. |
| `stats` | `--days N`, `--json` | Local counts for the last `N` days (1 to 90, default 30). There is no `stats share`. Exit `0`, or `2` if `--days` is out of range. |
| `check` | none | Runs the Python guard on a built-in fake secret and on a harmless text, in a temporary folder, and prints `PASS` or `FAIL` for each. Exit `0` only if the secret is blocked or redacted and the harmless text passes, `1` otherwise. Nothing is sent and the fake secret is never printed in full. It covers the Python guard only: for agent hooks (Claude Code, Codex, Cursor and others) run `npx -y zn-gate check`. |

The other commands on this page are only in the npm package. In the Python package they print a short note and exit `2`: `init`, `doctor`, `audit`, `hooks`, `run`, `secret`, `env`, `vault`, `unlock`, `lock`, `pins`, `mcp`, `shield`, `team`, `logs` and `export` point to `npx -y zn-gate init`, and `report`, `why`, `connect` and `disconnect` point to `npx -y zn-gate <command>`. `reach` is in the npm package too, except `reach --history`, which the Python package has as well (see [reach](reach.md#history-did-your-agents-keep-a-secret-of-yours)). A command neither package knows exits `1`. To use the optional cloud check from Python, set `ZN_CLOUD=1` and `ZN_API_KEY` (or pass `--key` to `analyze`) instead of running `connect`.
