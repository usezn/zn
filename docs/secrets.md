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

```
DATABASE_URL=postgres://app:__ZN_DATABASE_URL_PASSWORD__@db:5432/app
STRIPE_KEY=__ZN_STRIPE_KEY__
PORT=3000
```

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

## Useful commands

| Command | What it does |
|---|---|
| `zn secret list` | Names, modes, hosts and commands (never values) |
| `zn secret rm NAME` | Remove a secret |
| `zn vault log` | Local audit log: who used which secret where (no values). Also `zn secret log`; `--since 1h` limits it. (`zn audit` reviews agent configs; see [audit.md](audit.md)) |
| `zn vault log export --otlp` | The same log as OpenTelemetry logs (OTLP/JSON Lines) for an OpenTelemetry Collector; `--since 7d`, `--out FILE`. See [team.md](team.md#export-the-audit-log-to-opentelemetry) |
| `zn vault verify` | Check the audit log's HMAC chain |
| `zn lock` | Lock the vault now |
| `zn hooks uninstall <agent>` | Remove the hooks. For Claude Code it also removes zn's own `secrets` MCP server, and keeps any other server with that name |

If the vault is locked, the hooks still redact what they can recognise, but
with markers that cannot be restored (`__ZN_REDACTED_AWS_KEY__`), and remind
you to run `zn unlock`.
