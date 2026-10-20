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

> **Windows PowerShell:** `npm` and `npx` can fail with "running scripts is disabled on this system", because the default execution policy blocks `npm.ps1`. Use `npm.cmd` and `npx.cmd` instead (for example `npm.cmd install -g zn-gate`), and `claude.cmd` for Claude Code commands such as `claude.cmd plugin list`. PowerShell blocks `.ps1` scripts by default, and the `.cmd` file runs the same command. Or run the commands from Command Prompt, or allow local scripts for your account with `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

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

```
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

Allow the program that needs the value:

```bash
zn secret allow DATABASE_URL_PASSWORD --command psql
```

(If your password was short, the whole URL is in the vault, so allow
`DATABASE_URL` instead and write `psql "__ZN_DATABASE_URL__"`.)

When the agent runs `psql "postgres://app:__ZN_DATABASE_URL_PASSWORD__@db/app"`,
the hook routes it through `zn run`. The value goes only into that process, its
output is masked (raw, base64, hex and URL-encoded forms come back as the
marker), and the first time the vault asks you to confirm in its dialog or its
terminal. That prompt shows the exact program that will run. Changing a
secret's policy (`zn secret allow`) is confirmed the same way. The agent cannot
answer these prompts from its own terminal.

Allow a specific program. `node`, `python`, `npm`, `make` and other
interpreters run any code they are given, so allowing one lets every script it
runs read the secret; zn warns you when you do.

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
3. Write `__ZN_BRAVE_API_KEY__` where the value was, and start the server
   through `zn run`: set the server's `command` to `zn` and put `run`, `--`
   and the old command first in `args`. `zn run` replaces the marker in the
   server's environment and arguments with the real value, only inside that
   process (section 4 above).
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
| `zn vault log` | Local audit log: who used which secret where (no values). Also `zn secret log`; `--since 1h` limits it. (`zn audit` reviews agent configs; see [audit.md](audit.md)) |
| `zn vault log export --otlp` | The same log as OpenTelemetry logs (OTLP/JSON Lines) for an OpenTelemetry Collector; `--since 7d`, `--out FILE`. See [team.md](team.md#export-the-audit-log-to-opentelemetry) |
| `zn vault verify` | Check the audit log's HMAC chain |
| `zn lock` | Lock the vault now |
| `zn vault reset` | Forgot the passphrase? Sets the old vault aside and starts a new, empty one. Your own terminal only; the old values are lost. See "If something fails" |
| `zn hooks uninstall <agent>` | Remove the hooks. For Claude Code it also removes zn's own `secrets` MCP server, and keeps any other server with that name |

If the vault is locked, the hooks still redact what they can recognise, but
with markers that cannot be restored (`__ZN_REDACTED_AWS_KEY__`), and remind
you to run `zn unlock`.

## If something fails

- **You see `__ZN_REDACTED_...` markers**: the vault is locked. Run `zn unlock`.
- **No confirmation dialog appears** (a server, or SSH): run `zn unlock --foreground` in a terminal of its own and answer there.
- **You updated zn-gate and secrets still show as markers in the hooks**: the vault is still the old version. Run `zn vault status`, then `zn unlock`, which restarts it.
- **Codex does not run the hooks**: open Codex and approve them with `/hooks`.
- **Claude Code ignores the hooks on a computer managed by an organization**: `zn hooks install claude-code` and `zn-gate status` say when a managed setting stops them. Ask your administrator to add zn to the managed settings.
- **You forgot the vault passphrase**: nobody can recover it, so the values in that vault cannot be opened again. Run `zn lock`, then `zn vault reset` in your own terminal and type `reset my vault` when it asks. zn keeps the old vault in a `vault-backup-<date>-<time>` folder inside `~/.zn`, and the next `zn unlock` creates a new empty vault. Store your values again with `zn env shadow .env` or `zn secret set NAME`, and rotate any secret you cannot re-enter. It refuses if your agent runs it, if there is no terminal, or if this computer belongs to a zn Team organization.
- **You want your old `.env` back**: run the restore command that `zn env shadow` printed, for example `zn env unshadow .env --backup <name>`, in your own terminal.
- **Not sure what is protected**: run `npx -y zn-gate check`.

Words you do not know? See the [glossary](glossary.md).
