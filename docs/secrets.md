# Keep secrets out of your coding agent (5 minutes)

zn-gate keeps secret values out of what your coding agent sends to its model.
The agent works with markers such as `__ZN_GITHUB_TOKEN__`; real values stay in
an encrypted vault on your machine and are filled in only where you allowed
them. Everything runs locally.

Supported agents: Claude Code, Codex CLI, Cursor (IDE) and OpenCode. What each
one can and cannot do is in [compat.md](compat.md); the limits are in
[threat-model.md](threat-model.md).

## 1. Install and unlock the vault

```bash
npm install -g zn-gate
zn unlock
```

> **Windows PowerShell:** `npm` and `npx` can fail with "running scripts is disabled on this system", because the default execution policy blocks `npm.ps1`. Use `npm.cmd` and `npx.cmd` instead (for example `npm.cmd install -g zn-gate`), run the commands from Command Prompt, or allow local scripts for your account with `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

The first `zn unlock` creates the vault: an [age](https://age-encryption.org)
identity stored in your OS keychain (macOS Keychain, Windows Credential
Manager, or Secret Service on Linux), or behind a passphrase when there is no
keychain. The vault stays unlocked for 8 hours, or until 30 minutes without
use, or until `zn lock`.

After you update zn-gate, a vault that is still running from the older
version keeps secrets as markers in the agent hooks until it is restarted.
`zn vault status` shows the version of the running vault and flags an
outdated one, and `zn unlock` restarts it for you.

zn asks you to confirm some things outside the agent (step 4). On a desktop it
shows a system dialog. On a server or over SSH there is no dialog: run the
vault in a terminal of its own instead, and answer there:

```bash
zn unlock --foreground
```

## 2. Move your `.env` values into the vault

```bash
zn env shadow .env
```

Every sensitive value moves into the vault and `.env` keeps only markers:

```text
DATABASE_URL=postgres://app:__ZN_DATABASE_URL_PASSWORD__@db:5432/app
STRIPE_KEY=__ZN_STRIPE_KEY__
PORT=3000
```

For a connection string with a long password, only the password moves, as
`NAME_PASSWORD` (here `DATABASE_URL_PASSWORD`). With a short password, the
whole URL moves to the vault as `DATABASE_URL`, and `.env` keeps
`DATABASE_URL=__ZN_DATABASE_URL__`.

An encrypted copy of the original is kept (`zn env unshadow` restores it). To
add a single secret, type it at a hidden prompt (never as an argument):

```bash
zn secret set GITHUB_TOKEN --host api.github.com
```

## 3. Install the hooks for your agent

```bash
zn hooks install claude-code     # or: codex, cursor, opencode
```

From now on, every file read, command output and pasted prompt goes through the
scrubber before it reaches the model. Known values, more than 60 secret formats
(cloud keys, tokens, private keys, connection strings) and checksummed PII are
replaced with tokens. Reads of `.env` files with real values, credential files
(`~/.aws/credentials`, `~/.ssh/id_*`, `~/.npmrc`…) and zn's own `~/.zn` are
blocked.

### Name, address and username

Besides checksummed personal data (cards, IBAN, national IDs, e-mail, phone), the
scrubber detects three personal fields that have no checksum: a person's name
(`PERSON_NAME`), a postal address (`POSTAL_ADDRESS`) and a username (`USERNAME`).
They are matched only when an explicit key sits next to the value, so a bare
name in text is never touched. Only the value is replaced; the key stays.

| Type | HTTP header keys | Query string and form keys |
|---|---|---|
| `PERSON_NAME` | `X-User-Name`, `X-Full-Name` | `full_name`, `fullname`, `name` |
| `POSTAL_ADDRESS` | `X-Address` | `address` |
| `USERNAME` | `X-Username`, `X-User`, `X-Forwarded-User`, `X-Remote-User` | `username`, `user`, `login` |

- Keys are case-insensitive. A header value runs to the end of the line (or to
  the closing quote when the header sits in JSON or in `curl -H '...'`). A query
  or form value runs to the next `&`; spaces must be encoded (`+` or `%20`)
  inside a query string. A `key=value` line is also read when the key starts in
  column 0.
- Only headers, query strings and form bodies are in scope. Code (keyword
  arguments such as `f(user=x)`), JSON schemas, `package.json` and ALL-CAPS
  environment variables (`USER=...`) are not matched.
- Empty values, placeholders (`${USER}`, `<name>`, `null`, `anonymous`) and
  values that cannot be what the key says are skipped: `name=build` is not a
  person, and a generic `name=` needs two capitalised words. A username must
  be a plain token (letters, digits, `.`, `_`, `-`) and not `root`, `admin`,
  `ubuntu` or similar. An address needs a number and at least two words, so
  URLs, e-mails, IPs and wallet addresses are skipped.

They are personal data, not secrets: they follow the scrubber's `pii` setting
(`pii: false` turns all personal data off) and can be switched off one by one
with `pii: { name: false, address: false, username: false }`. They are on by
default.

A prompt that contains a secret is not sent. In prompts, zn also blocks a
value of 8 characters or more given to a credential name, in the middle of a
sentence too
(`my key is STRIPE_KEY=...`, `DB_PASSWORD=...`), unless the value is a
placeholder (`changeme123`, `<key>`), a reference (`${API_KEY}`,
`__ZN_STRIPE_KEY__`) or code. Store the value with `zn secret set NAME` and
write `__ZN_NAME__` in the prompt instead.

The block message names the credential when the text shows its name, for example
`this prompt was not sent because it contains a secret (DB_PASSWORD)`. The value is never shown.

A value that says it is fake is a placeholder and is not blocked, on purpose, so examples and test data still work.
`STRIPE_KEY=FAKE_NOT_A_REAL_KEY_1234` passes silently. A value counts as fake when it contains a word such as
FAKE, DUMMY, EXAMPLE, MOCK, SAMPLE, PLACEHOLDER or CHANGEME. Use a real value only through the vault.

Codex runs new hooks only after you trust them: open Codex and use `/hooks`.

On a computer managed by an organization, Claude Code can be set up to ignore
the hooks and MCP servers you install yourself (`disableAllHooks`,
`allowManagedHooksOnly`, `managed-mcp.json`, or an MCP allowlist or denylist),
and it does not tell you. `zn hooks install claude-code` and `zn-gate status`
read the managed settings files on this computer and your own settings, and
say when one of these stops zn's hooks or its `secrets` server. Ask your
administrator to add zn to the managed settings. Policy sent through claude.ai,
device management (MDM) or the Windows registry is not read, and when such a
policy exists Claude Code may ignore the managed settings files; `claude
doctor` and `/status` show which source Claude Code used.

## 4. Let a command use a secret

A program gets a secret through its environment, never through its arguments:
an argument is visible to every process of your user (`ps`) and ends up in
command-line logs, so zn does not put a value there. If the agent writes a
marker such as `__ZN_NAME__` in a command's arguments, zn refuses the command
and tells the agent to pass the secret as an environment variable instead.

Store the secret under the name the program reads and allow that program. For
example, `psql` reads its password from `PGPASSWORD`:

```bash
zn secret set PGPASSWORD --command psql
```

The agent then runs the command through `zn run`, naming the secret with
`--secrets`:

```bash
zn run --secrets PGPASSWORD -- psql -h db.example.test -U app -c "select 1"
```

The value goes only into that process's environment. Its output is masked (raw,
base64, hex and URL-encoded forms come back as the marker; standard output and
standard error are masked separately, so a value that a program splits between
the two is not caught), and the first time the vault asks you to confirm in its
dialog or its terminal. That prompt shows the exact program that will run.
Changing a secret's policy (`zn secret allow`) is confirmed the same way. The
agent cannot answer these prompts from its own terminal.

A marker in the environment that `zn run` inherits (for example a value from
a shadowed `.env` that your shell or direnv loads) is filled in the same way,
when the secret allows that program and you have approved it
(`zn secret approve NAME --command psql`).

Allow a specific program. `node`, `python`, `npm`, `make` and other
interpreters run any code they are given, so allowing one lets every script it
runs read the secret; zn warns you when you do.

What an environment variable does and does not hide:

- It is not in the process list (`ps`), in shell history, or in a log of the
  command line.
- Other processes of your user can still read it (on Linux, from
  `/proc/<pid>/environ`), and the program can pass it on. If the program
  copies the value into the arguments of another program (for example
  `sh -c 'psql "$PGPASSWORD"'` expands it into the arguments of `psql`), that
  copy is visible again. Let the program read the variable itself, or take
  the secret from standard input or a file where it supports that.
- The loader and interpreter start-up variables are removed from the
  environment while values are injected; see
  [threat-model.md](threat-model.md#starting-the-approved-program).

## 5. Let the agent call an API

For HTTP APIs, use the `secrets` MCP server instead of putting the value in a
process. `zn hooks install` prints how to register it for your agent. The agent
calls `secrets_http_request` with the marker in a header:

```json
{ "method": "GET", "url": "https://api.github.com/user",
  "headers": { "Authorization": "Bearer __ZN_GITHUB_TOKEN__" } }
```

zn sends the request only to the secret's `allowHosts`, only with the value in
headers (the URL or the body need `zn secret allow NAME --in query|body`), and
returns the response with secrets replaced by markers. There is no tool that
returns a value.

Only a secret in `proxy` mode is sent this way, which is what `zn secret set
NAME --host api.github.com` stores. A secret stored for a program (`env` mode,
`--command`) or for a file (`file` mode) is never sent over HTTP by this tool,
even if it also has an allowed host: the tool refuses it and nothing is sent.
Change the mode yourself with `zn secret allow NAME --mode proxy` if the API
really needs it.

## MCP server configs

MCP server configs (`.mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`,
`.codex/config.toml`, `claude_desktop_config.json`, Antigravity's
`mcp_config.json` and similar) often hold a key in plain text, in the server's
`env`, in a header or in its arguments, and then travel with the repository or
a backup. `zn scan` and `zn audit` find them, and never print the value: they
show the kind (environment variable, header, argument, URL), the name that
holds it, the file and the line.

```bash
zn scan .                  # this project's MCP configs, with the rest of the scan
zn scan --include-home     # also your own MCP configs (Claude Desktop, Claude Code, Cursor, Codex, ...)
zn audit .                 # the same finding as ZNA011, also as SARIF for code scanning
```

`--include-home` reads a config only when its real path, after following every symbolic link (also on a folder such as `~/.codex`), is inside your home folder. In `~/.claude.json` the key Claude Code uses to log in (`primaryApiKey`) is not reported, because moving it would break the login.

What the check calls a credential: a value under a name that ends in a secret
word (`BRAVE_API_KEY`, `token`, `password`, `Authorization`, `X-Api-Key`), the
value after a credential flag in `args` (`--api-key`, `--token`), and a key in a
URL (`?api_key=...`). It does not report a reference (`${NAME}`, `$NAME`,
`__ZN_NAME__`), a placeholder, a file path or a value that reads as ordinary
text.

To fix one:

1. Store the value: `zn secret set BRAVE_API_KEY` (it asks for the value at a
   hidden prompt).
2. Allow the server's program to use it: `zn secret allow BRAVE_API_KEY
   --command npx` (use the program the server's `command` runs).
3. Remove the value from the file and start the server through `zn run`: set
   the server's `command` to `zn` and put `run`, `--secrets`, `BRAVE_API_KEY`,
   `--` and the old command first in `args`. The server gets the value as the
   environment variable `BRAVE_API_KEY`, only inside that process (section 4
   above). A key that was a command-line argument (`--api-key ...`) has to move
   to an environment variable the server reads: `zn run` does not fill a marker
   written in an argument.
4. For a header or a URL of a remote server there is no process to start, so
   refer to an environment variable instead, written the way your agent
   expects (`${BRAVE_API_KEY}` in Claude Code, `${env:BRAVE_API_KEY}` in
   Cursor and VS Code, `{env:BRAVE_API_KEY}` in OpenCode), and keep the value
   in your shell settings or a secret manager. An agent that cannot read
   variables in its config (Claude Desktop does not) needs the server kept in
   a file outside the repository.
5. Rotate the value if the file was ever committed, synced or shared.

## AWS documentation example keys

Access key ids are redacted by their format, whatever their last characters
are. The key id used in AWS documentation (it ends in `EXAMPLE`) is
redacted too, for every prefix (`AKIA`, `ASIA`, `ABIA`, `ACCA`). A real key id
is never skipped because of how it ends, and redacting a documentation
example costs nothing.

## Useful commands

| Command | What it does |
|---|---|
| `zn secret list` | Names, modes, hosts and commands (never values) |
| `zn secret rm NAME` | Remove a secret |
| `zn vault log` | Local audit log: who used which secret where (no values). Also `zn secret log`; `--since 1h` limits it. With the vault unlocked it checks the whole chain first and shows nothing if the check fails (the vault stores a warning); with the vault locked it says the chain was not checked. (`zn audit` reviews agent configs; see [audit.md](audit.md)) |
| `zn vault log export --otlp` | The same log as OpenTelemetry logs (OTLP/JSON Lines) for an OpenTelemetry Collector; `--since 7d`, `--out FILE`. An unlocked vault checks the chain first and refuses to export a log that does not verify; a locked vault cannot, and the export warns that it is not a verified copy. See [team.md](team.md#export-the-audit-log-to-opentelemetry) |
| `zn vault verify` | Check the audit log's HMAC chain and compare its last record with the one the vault remembers. If the log was cut or replaced while the vault was locked or running, the vault keeps a warning (also after lock and unlock) and this command fails until you look into it and accept the log with `zn vault verify --acknowledge` in your own terminal (the vault asks you to confirm). The vault saves its checkpoint every minute and when it locks; if the vault process is killed, the records of the last minute may be missing without notice. Restoring an older `secrets.age`, with or without its older `audit.jsonl`, is not detected. After a power loss the check can report a false alarm |
| `zn lock` | Lock the vault now |
| `zn vault reset` | Forgot the passphrase? Sets the old vault aside (an encrypted backup) and starts a new, empty one. Your own terminal only; the old values are lost. See "If something fails" |
| `zn vault purge` | Deletes the vault for good: it lists every file (vault, token maps, audit log, all backups, session key), asks you to type `purge my vault`, deletes them and checks that none is left. Your own terminal only (`--yes` for a script); cannot be undone |
| `zn hooks uninstall <agent>` | Remove the hooks. For Claude Code it also removes zn's own `secrets` MCP server, and keeps any other server with that name |

### Audit log size and segments

The audit log is `~/.zn/audit.jsonl`. When it reaches 128 MiB, zn closes it as a
segment: it writes one last record (decision `rotate`), renames the file to
`~/.zn/audit.1.jsonl` (then `audit.2.jsonl`, and so on) and goes on in a new
`audit.jsonl`. The hash chain continues across the files, so `zn vault verify`,
`zn vault log`, the OpenTelemetry export and the Team upload read every segment
in order and nothing is lost. zn never deletes a segment by itself: they are the
history the chain vouches for, and a segment that is deleted, edited or renamed
makes `zn vault verify` fail. Do not remove them by hand; `zn vault reset`,
`zn vault purge` and the vault part of `zn-gate uninstall` delete all of them. To
free disk space, copy the segments somewhere safe first, then run `zn vault reset`.
A log that has been closed as a segment needs a zn-gate newer than 1.14.1 to be read:
an older version reports the new `audit.jsonl` as a broken chain.

If the vault is locked, the hooks still redact what they can recognise, but
with markers that cannot be restored (`__ZN_REDACTED_AWS_KEY__`), and remind
you to run `zn unlock`.

## If something fails

- **You see `__ZN_REDACTED_...` markers**: the vault is locked. Run `zn unlock`.
- **No confirmation dialog appears** (a server, or SSH): run `zn unlock --foreground` in a terminal of its own and answer there.
- **You updated zn-gate and secrets still show as markers in the hooks**: the vault is still the old version. Run `zn vault status`, then `zn unlock`, which restarts it.
- **Codex does not run the hooks**: open Codex and approve them with `/hooks`.
- **Claude Code ignores the hooks on a computer managed by an organization**: `zn hooks install claude-code` and `zn-gate status` say when a managed setting stops them. Ask your administrator to add zn to the managed settings.
- **You forgot the vault passphrase**: nobody can recover it, so the values in that vault cannot be opened again. Run `zn lock`, then `zn vault reset` in your own terminal and type `reset my vault` when it asks. zn keeps the old vault in a `vault-backup-<date>-<time>` folder inside `~/.zn`, and the next `zn unlock` creates a new empty vault. The backup stays encrypted; `zn vault purge` is the separate command that deletes it, with the vault and its token maps. Store your values again with `zn env shadow .env` or `zn secret set NAME`, and rotate any secret you cannot re-enter. It refuses if your agent runs it, if there is no terminal, or if this computer belongs to a zn Team organization.
- **You want your old `.env` back**: run the restore command that `zn env shadow` printed, for example `zn env unshadow .env --backup <name>`, in your own terminal.
- **Not sure what is protected**: run `npx -y zn-gate check`.

Words you do not know? See the [glossary](glossary.md).
