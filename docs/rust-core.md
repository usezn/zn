# Rust gateway (legacy, not released)

## In one minute

The Rust gateway in the root `src/` directory is an older, experimental program that is not released: `npx zn-gate`, `npm install zn-gate`, `pip install zn-gate` and the agent plugin do not contain or start it. You only run it if you build `src/` yourself. It serves a management API and an MCP proxy on `localhost:9090`, checks tool calls with its rules, and keeps an audit log in SQLite that stores only metadata unless you turn payloads on (`audit.store_payloads`, off by default). Nothing in its source names `api.usezn.com`. Its restricted-command rule matches a short list of whole words in the arguments (`rm`, `dd`, `format`, `mkfs`, `chmod`, `chown`, `shutdown`, `reboot`; a tool name also matches a few joined forms such as `rmrf` or `rimraf`), so it misses many destructive shell commands, such as a download piped into a shell. To protect an agent, use `zn-gate`.

The root `src/` directory contains the original Rust gateway (`zn`) from the 1.0.0 line: an HTTP management API and MCP proxy on `localhost:9090`, a rules engine, an optional local ONNX classifier (Candle), a SQLite audit log, WASM policies and a terminal UI.

It is **experimental** and **not distributed**: nothing you install with `npx zn-gate`, `npm install zn-gate`, `pip install zn-gate` or the agent plugin contains or starts it. It is kept for reference and for future work on a local classifier. It is not published on crates.io, has no published container image and is not part of the npm or PyPI packages. CI builds it, runs its tests, clippy and rustfmt, and checks its dependencies with `cargo audit` (`.github/workflows/cargo-audit.yml`). `zn mcp` exposes two MCP tools: `analyze_prompt` and `version`.

The Rust gateway reads `ZN_API_KEY` as the key for its own management API. It never contacts `api.usezn.com`.

On first start, with an empty database, the gateway seeds a default organisation with a super-admin key. The key is `ZN_API_KEY` if it is set, otherwise a random key.

A random key is written to `zn-superadmin-key.txt` next to the audit database (`zn.db` by default). The file is readable only by your user (mode 0600 on Unix; on Windows the file inherits the permissions of its directory). Copy the key somewhere safe, then delete the file.

The key is never printed, so it does not end up in terminal scrollback or container logs. Earlier versions printed a generated key to stdout. If the file cannot be written, the gateway does not start and seeds nothing.

The gateway's rules do not cover shell commands the way the [destructive-command check](destructive-commands.md) of `zn-gate` does. Its restricted-command rule blocks any call that contains the word `rm`, `dd`, `chmod`, `chown`, `mkfs`, `format`, `shutdown` or `reboot`, whatever the target, so it also blocks harmless commands such as `rm -rf ./build`. It has no rule for a download piped into a shell, a download written over a shell startup file, a fork bomb, or writing to a disk device with a redirect (`cat /dev/zero > /dev/sda`). Do not rely on it to stop destructive commands: use `zn-gate`.

> For agent protection (Claude Code, Codex CLI, Cursor, OpenCode, Antigravity, ZCode desktop app, GitHub Copilot, Gemini CLI (experimental), LangChain, CrewAI), use `zn-gate` (Node.js) or `zn-gate` on PyPI (Python). They need no compilation.

## Hardening (October 2026)

A review of an older snapshot of this gateway found issues that only affect someone who builds `src/` and runs `zn start` themselves. Most were already fixed; these changed now:

- **Bans per tenant.** The reputation and ban list is kept per namespace (WebSocket tenant or the configured namespace) and agent id, so a tenant can no longer ban another tenant's agent ids (such as the default `anonymous`), and `/api/v1/reputation` shows a tenant only its own namespace. The agent id in a message is a label, not an identity, and is cut to 128 characters. The loop breaker and multi-signature approvals are kept per namespace too, so one tenant cannot trip the loop breaker of another or use an approval it did not ask for.
- **Sanitized images are forwarded.** With `visual_pii_redaction` on, an allowed tool call now carries the sanitized arguments (metadata stripped), the same ones that were checked and stored in the audit vault, instead of the original frame, in the place they were read from (the rebuilt frame may list its keys in another order). If the frame cannot be rebuilt, the call is refused.
- **Bounded WebSocket messages.** `/mcp/ws` closes a connection whose message or frame is over 1 MiB (the library default was 64 MiB).
- **WebSocket limits are configurable.** The limits are the `server.ws_max_message_bytes` (default 1048576, 1 MiB) and `server.ws_max_frame_bytes` (default 1048576, 1 MiB) settings; a message or frame over its limit closes the connection.
- **Idle and stuck connections are closed.** A management API connection that sends nothing for `server.session_idle_timeout_secs` (default 900, 15 minutes) is closed, which ends an unused SSE stream or WebSocket session; browsers reconnect on their own. A client that stops reading is cut after `server.write_timeout_secs` (default 30). A value of 0 keeps the default.
- **Idle sockets cannot lock out the dashboard.** The management API serves at most 256 connections at once. When the limit is reached, a new connection takes the place of the oldest idle connection that has not yet had a request answered successfully. Only if there is none does it take the place of the oldest idle connection that was served before, such as a long-lived idle WebSocket session. A connection with a request in flight is never closed to make room.
- **Consensus actions expire.** A proposed action that is not approved within `consensus.pending_ttl_secs` seconds (default 900, 15 minutes; 0 means the default) can no longer be approved and is removed.
- **Query-string credentials only for SSE and WebSocket.** The `api_key` and `token` query parameters are accepted only on `/api/v1/events` and `/mcp/ws`, where a browser client cannot send headers; on every other route a credential must come in a header.

A policy upload is verified before anything is written. The gateway checks these on the uploaded bytes in memory:

- the allowed-hash list;
- the Ed25519 signature;
- the ML-DSA-65 signature, when `ZN_PQ_PUBLIC_KEY` is set (this then makes it mandatory);
- that the WASM compiles.

It reads the signatures from the `.wasm.sig` and `.wasm.pqs` files next to the policy.

Only then does it write the file. It writes to a temporary file in the policy directory, which is synced and renamed over the target. A policy that fails any check leaves no file behind, and a policy already installed under that name stays as it was.

Known limits that remain, because the gateway is not distributed: bans and the loop breaker follow the agent id that the message gives, inside its namespace, so a client that changes its agent id on every call starts each time with a clean record (the fixed rules and policies still check every call; give each client its own namespace to keep it apart); the OCR check of images uses a fixed list of phrases and recognises only `data:image/...;base64,` images; the audit vault and the loop breaker have no size or age limit; and the management API has no TLS of its own (it listens on `127.0.0.1`; outside loopback, put it behind a TLS proxy).

## Hardening (November 2026)

A further review of the request path changed these:

- **Deep frames are refused.** A frame that nests objects or arrays more than 64 levels deep is refused with a JSON-RPC `-32600` error before it is parsed. Before, a deeply nested unknown field could stop the repeated-key check early while the request was still accepted, so a key repeated after that field (in the tool arguments, the tool name or an A2A task) was not seen. The repeated-key check now also refuses any frame it could not read to the end.
- **Bounded policy state.** The `zn_state_set` and `zn_state_get` functions that WASM policies call check the lengths they are given before using them: a key is at most 4 KiB, a value at most 64 KiB, and the range must lie inside the policy's memory. A call outside those limits is ignored (`zn_state_get` returns 0) instead of making the gateway allocate the size the policy asked for. The shared state holds at most 1,024 keys.
- **A policy that does not load stops the start.** If a `.wasm` file in the policy folder cannot be loaded (its hash is not in `engine.allowed_policy_hashes`, its signature does not match, or the file is incomplete), `zn start` now stops with an error that lists each file and the reason, instead of starting without that policy. A policy file that changes while zn runs and then fails to load is logged as an error and the version loaded before stays in force.

## Settings checked at start

A mistyped value in these settings used to switch a protection off without a word. The gateway now reads them strictly and refuses to start, with a message that names the setting, when a value cannot be used:

- **`environment` / `ZN_ENV`.** Accepts `development` (the default) or `production`, in any capitalisation and with spaces around it ignored, so `Production` means production. Any other value, such as `prod` or `staging`, stops the start and the message lists the two accepted values. An unset or empty `ZN_ENV` keeps the value from `zn.json`. In production the audit database must be encrypted (`ZN_DB_KEY`, or a KMS key), and the gateway warns when no `ZN_API_KEY` protects the management API.
- **`engine.allowed_policy_hashes` / `ZN_POLICY_HASHES`.** Each entry is the SHA-256 of a policy file: 64 hexadecimal characters, for example the first column of `sha256sum policy.wasm`. `ZN_POLICY_HASHES` takes the hashes separated by commas. Spaces and newlines around a hash are ignored, upper case is accepted, and empty entries are skipped. An entry that is not a hash stops the start and the message names it; so does a list that holds no hash at all (for example `ZN_POLICY_HASHES=,`). An empty list, or an unset or empty `ZN_POLICY_HASHES`, means no allow list: every policy is accepted, subject to its signature.
- **`audit.db_path` / `ZN_DB_PATH` / `--db-path`.** The audit database file, `zn.db` by default. An empty or blank path stops the start: SQLite would otherwise keep the audit log in a temporary database that is lost when the gateway stops.
- **`audit.encryption_key` / `ZN_DB_KEY`.** The passphrase of the audit database. Spaces and newlines around it are ignored, and an empty or blank value counts as not set (so production refuses to start without a real key). A passphrase shorter than 16 characters stops the start; use a long random value, for example `openssl rand -hex 32`. A database created with a shorter passphrase is not opened by this version.
- **`engine.policy_dir`.** The folder of `.wasm` policies, `./policies_bin` by default, relative to the folder zn starts in. zn creates only the default folder when it is missing. A folder named in `zn.json` that does not exist (a typo, a trailing space, or a path that belongs to another working folder) stops the start; it is not created. A named folder that exists but holds no `.wasm` file starts the gateway with the warning `zero security policies loaded from <folder>`, because no policy then checks tool calls. An empty `engine.policy_dir` stops the start.
- **`security.allowed_origins` / `ZN_ALLOWED_ORIGINS`.** The browser origins allowed for the management API and the MCP WebSocket. `ZN_ALLOWED_ORIGINS` takes origins separated by commas. Each entry is trimmed, a trailing `/` is dropped and empty entries are skipped, so an empty value or `,` gives an empty list, which allows only loopback origins (`localhost` and `127.0.0.1`); a WebSocket upgrade without an `Origin` header is then refused. An entry must be `http://` or `https://`, a host and an optional port, with no path (`https://app.example.com`). The wildcard `*` and anything else that is not an origin stop the start and the message names the setting.
- **`siem.endpoint` / `ZN_SIEM_ENDPOINT`.** An empty or blank value means no SIEM export. Otherwise it must be an `http://` or `https://` URL; anything else stops the start (the message never repeats the value, which can hold a token). Before, a bad value was accepted and failed at the first event.
- **`kms.kms_type` / `ZN_KMS_TYPE`.** `local` (the default) or `aws`, in any capitalisation. Any other value (`gcp`, `vaults`, a typo) stops the start; it no longer falls back to the local key. A blank `ZN_KMS_TYPE` keeps the value from `zn.json`.
- **Thresholds.** `neural.threshold` / `ZN_NEURAL_THRESHOLD` is a number from 0 to 10; `fusion.tau` and `guardrails.fpr_margin` / `ZN_FPR_MARGIN` are numbers from 0 to 1. `NaN`, infinity, a negative number, a number out of range and, for the variables, a value that is not a number stop the start. A blank variable keeps the value from `zn.json`.
- **`guardrails.paranoia_level` / `ZN_PARANOIA_LEVEL`.** A whole number from 1 to 5. Any other value, in the variable or in `zn.json` (`high`, `300`, `-1`, `0`, `6`), stops the start. Before, a bad variable was ignored and `0` was raised to 1.
- **`consensus.critical_tools`.** `consensus.enabled` with no tool listed stops the start, because no call would need approval. Spaces around a name or prefix in `zn.json` are removed and empty entries are dropped; a pattern with spaces around it in a configuration built in code is refused.
- **The settings file.** It must be a JSON object (`{ ... }`). A JSON array or any other value stops the start. When zn takes `zn.json`, `zn.config.json` or `.zn.json` from the current folder without `--config`, it logs `settings loaded from <file>`, and warns when that file turns off managed rules, the loop breaker, neural analysis or rate limiting.

- **`server.channel_capacity`.** The size of the event queue behind the live stream, a whole number from 1 to 1,000,000 (default 100). `0` or a value above the range stops the start; before, `0` aborted the process and a huge value tried to reserve all the memory.
- **`engine.memory_limit_mb` / `ZN_MEMORY_LIMIT`.** The memory a policy may use, in megabytes (default 128). A value too large to count in bytes (above 17,592,186,044,415) stops the start with a message that names the setting.
- **The neural model.** If the model cannot be loaded (the folder is damaged, or the first download fails), `zn start` stops with an error that names the folder and the three ways out: fix `neural.model_path` or `ZN_NEURAL_MODEL_PATH`, fix the connection or `HF_ENDPOINT`, or turn the neural check off. Before, it aborted with a panic.

## Environment variables

Every variable the gateway reads. A variable that is set overrides the same setting in `zn.json`. "On/off" variables take `1`, `0`, `true`, `false`, `yes`, `no`, `on` or `off`, in any capitalisation and with spaces around the value ignored; an unset or blank variable keeps the default, and any other word (for example `0n` or `fasle`) stops the start with a message that names the variable. A blank value of any other variable counts as not set, unless the table says otherwise.

| Variable | Meaning | Default | Accepted values |
|---|---|---|---|
| `ZN_ENV` | `environment`: development or production (see [Production mode](#production-mode)). | `development` | `development`, `production` |
| `ZN_PORT` | `server.port`: port of the management API. A value that is not a port is ignored with a warning. | `9090` | whole number, 0 to 65535 |
| `ZN_API_KEY` | Key of the management API (super-admin). | none: a random key is written to a file | any non-blank text |
| `ZN_NAMESPACE` | `security.namespace`: namespace of the local stdio proxy and `zn analyze`. | `global` | a namespace name |
| `ZN_JWT_SECRET` | HS256 secret that checks JWTs. | none (JWTs refused) | at least 32 bytes |
| `ZN_ALLOWED_ORIGINS` | `security.allowed_origins`: browser origins allowed for the API and the WebSocket. | loopback only | origins separated by commas, never `*` |
| `ZN_MCP_WS_TOKEN` | Extra token for `/mcp/ws`. | none: a random token is written to a file | any non-blank text |
| `ZN_GAS_LIMIT` | `engine.gas_limit`: instructions a policy may run. A value that is not a number is ignored. | `10000000` | whole number |
| `ZN_MEMORY_LIMIT` | `engine.memory_limit_mb`: megabytes a policy may use. A value that is not a number is ignored. | `128` | whole number (see above for the top) |
| `ZN_TIMEOUT` | `engine.timeout_ms`: milliseconds a policy may run. A value that is not a number is ignored. | `1000` | whole number |
| `ZN_POLICY_HASHES` | `engine.allowed_policy_hashes`: SHA-256 of each policy that may load. | empty (any hash) | 64 hex characters each, separated by commas |
| `ZN_SIGNING_PUBLIC_KEY` | `engine.signing_public_key`: Ed25519 public key that policy signatures must match. | none | 64 hex characters |
| `ZN_PQ_PUBLIC_KEY` | ML-DSA-65 public key; when set, a post-quantum signature is mandatory. | none | hex |
| `ZN_DB_PATH` | `audit.db_path`: the audit database file. | `zn.db` | a file path, not blank |
| `ZN_DB_KEY` | `audit.encryption_key`: passphrase of the audit database. | none | at least 16 characters |
| `ZN_SIEM_ENDPOINT` | `siem.endpoint`: where audit events are exported. | none (no export) | an `http://` or `https://` URL |
| `ZN_SIEM_TOKEN` | `siem.token`: token sent to the SIEM. | none | any text |
| `ZN_KMS_TYPE` | `kms.kms_type`: where the audit key comes from. | `local` | `local`, `aws` |
| `ZN_KMS_KEY_ID` | `kms.key_id`: KMS key id or ARN. | none | any text |
| `ZN_KMS_REGION` | `kms.region`: AWS region of the KMS key. Without it the AWS environment decides (`AWS_REGION`, the profile). | none | an AWS region such as `eu-west-1` |
| `ZN_KMS_ALLOW_CONFIG_FALLBACK` | `kms.allow_config_fallback`: start with the key from the config when the KMS key cannot be fetched. | off | on/off |
| `ZN_KMS_RECOVER_NEW_DATA_KEY` | Allows one start with a new KMS data key, losing older encrypted records (see [AWS KMS data key](#aws-kms-data-key)). Remove it afterwards. | off | on/off |
| `ZN_NEURAL_ENABLED` | `neural.enabled`: the neural check. | on | on/off |
| `ZN_NEURAL_THRESHOLD` | `neural.threshold`: anomaly distance above which a call is flagged. | `1.2` | number, 0 to 10 |
| `ZN_NEURAL_BLOCKING` | `neural.active_blocking`: block what the neural check flags (otherwise it only reports). | off | on/off |
| `ZN_NEURAL_MODEL_PATH` | Folder of the embedding model; overrides `neural.model_path`. | `~/.zn/models/all-MiniLM-L6-v2` | a folder path |
| `ZN_GUARDRAILS_ALERT_ONLY` | `guardrails.alert_only`: neural findings only alert. | on | on/off |
| `ZN_PARANOIA_LEVEL` | `guardrails.paranoia_level`: 1 is relaxed, 5 is strict. | `1` | whole number, 1 to 5 |
| `ZN_MIN_SAMPLES` | `guardrails.min_samples`: samples before the false-positive guard judges. A value that is not a number is ignored. | `50` | whole number |
| `ZN_FPR_MARGIN` | `guardrails.fpr_margin`: false-positive margin before a roll back. | `0.02` | number, 0 to 1 |
| `ZN_NEAREST_NEIGHBOR_AUDIT` | `guardrails.nearest_neighbor_audit`: record the closest earlier call (by reference, never its content). | on | on/off |
| `ZN_AUDIT_STORE_PAYLOADS` | `audit.store_payloads`: keep the scrubbed request in the audit log (needs a key). | off | on/off |
| `ZN_AUDIT_REQUIRE_WRITE` | `audit.require_write`: deny a call whose audit record cannot be written. | off | on/off |
| `ZN_FAST_BOOT` | Skip loading the neural model (tests only; see [Model download on first start](#model-download-on-first-start)). | off | on/off |
| `HF_ENDPOINT` | Server the model is downloaded from. | `https://huggingface.co` | a URL |
| `ZN_MEMORY_MAX_AGENT_ROWS`, `ZN_MEMORY_MAX_NAMESPACE_ROWS`, `ZN_MEMORY_MAX_TOTAL_ROWS` | Vector memory limits (see [Vector memory limits](#vector-memory-limits)). | 10,000, 25,000, 100,000 | whole number, 1 to 100,000,000 |
| `ZN_OTLP_ENDPOINT` | Base URL of an OpenTelemetry collector; traces go to `<url>/v1/traces`. Wins over the two `OTEL_` variables. | none | a URL |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, `OTEL_EXPORTER_OTLP_ENDPOINT` | The standard OpenTelemetry endpoint variables, used when `ZN_OTLP_ENDPOINT` is not set. | `http://localhost:4318/v1/traces` | a URL |
| `RUST_LOG` | Log level filter. | `info` | a `tracing` filter such as `debug` or `zn=debug` |

## Production mode

`ZN_ENV=production` (or `"environment": "production"`) turns on two checks:

- The audit database must be encrypted: set `ZN_DB_KEY` (at least 16 characters; it also turns encryption on), or `audit.encryption_enabled` with `audit.encryption_key` in `zn.json`. Without a key, `zn start` stops with the message "Audit log encryption is MANDATORY in production".
- With no `ZN_API_KEY`, the gateway warns at start that the management API is unprotected. It still starts.

Nothing else changes with the environment name: the defaults of the other settings are the same in development and in production.

## Settings file keys

`zn init` writes a `zn.json` with every key below at its default. A variable from the previous section overrides the key of the same name. Keys with no variable:

| Section | Keys (default) |
|---|---|
| `server` | `bind_address` (`127.0.0.1`); `channel_capacity` (100, 1 to 1,000,000); `ws_max_message_bytes` and `ws_max_frame_bytes` (1,048,576 each); `session_idle_timeout_secs` (900) and `write_timeout_secs` (30), where 0 means the default |
| `security` | `rate_limit_enabled` (true; false turns the limiter off and logs a warning at start); `rate_limit_per_minute` (60, at least 1; the size of the burst each client may send before it is limited to one request per second) |
| `audit` | `encryption_enabled` (false; `ZN_DB_KEY` turns it on) |
| `siem` | `batch_size` (10) |
| `neural` | `model_id` (`all-MiniLM-L6-v2`); `dim` (384, must match the model) |
| `fusion` | `enabled` (false); `tau` (0.623, 0 to 1); `model_path`; `model_id` |
| `managed_rules` | `pii_redaction`, `lfi_protection`, `sql_injection`, `prompt_injection`, `restricted_commands` (all true); `visual_pii_redaction` (false) |
| `loop_breaker` | `enabled` (true); `max_repeats` (3); `window_seconds` (60) |
| `caching` | `enabled` (false); `ttl_seconds` (300, at most one year) |
| `consensus` | `enabled` (false); `critical_tools` (empty; required when enabled); `required_signatures` (2); `pending_ttl_secs` (900) |
| `webhooks` | a list of webhook targets (empty) |

### Settings that no longer do anything

These keys are still accepted so that an existing `zn.json` keeps working, but nothing reads them. `zn init` no longer writes them, and a file that sets one gets a warning at start (`... which zn ignores ... will be removed in a later release`). Delete the line.

- `audit.max_logs_in_memory`: no code reads it.
- `neural.classifier_threshold`: the classifier threshold comes from `guardrails.paranoia_level` (0.7 at level 1, down to 0.3 at level 5). It is no longer range-checked.
- `consensus.neural_as_witness`: the neural check never signs an action; only people do (`/api/v1/consensus/sign`).

`security.rate_limit_enabled` and `kms.region` were also ignored before. They are now applied: the first turns the limiter off, the second selects the AWS region of the KMS client (it was not applied at all; `ZN_KMS_REGION` is read the same way).

## Audit payloads

By default the audit database keeps only metadata for each call: event, time, tool name, status, matched policy, agent and namespace. The request payload is not stored. To keep payloads, set `audit.store_payloads = true` (or `ZN_AUDIT_STORE_PAYLOADS=1`); this needs an encryption key (`ZN_DB_KEY`, or a KMS key) in every environment, and the gateway refuses to start without one. Payloads are scrubbed before they are written. Records written by earlier versions stay readable.

A database that was set up with an encryption key is not opened without it. If you start the gateway without `ZN_DB_KEY` (or a KMS key) against such a database, it stops with an error that names these two settings; set the key it was created with and start again. Keep the file: its records cannot be read without the key.

Calls keep no content in the audit database, the event stream or the vector memory by default. With the neural layer on (the default), the memory keeps the vector of each call and a hash of it, not the arguments, and the `nearest_neighbor` field and the neural veto log name the closest earlier call only by a short reference (`h:` and 16 hex characters of its HMAC-SHA256) plus the distance. The reference is a keyed hash (HMAC) with a key kept on this machine (`data/ref.key`, created on first start; it is created readable by its owner only, mode 0600 on Unix and an owner-only access list on Windows); keep that file private, because the key is what stops short values such as PINs or codes from being recovered from a reference. The neighbour record is written before the call record, so with `audit.require_write` a failed write denies the call before any call record exists. Vector memory files written by earlier versions held the text of old calls; on the first start of this version the gateway replaces that text with the keyed reference, compacts the file, and does not use a file it could not clean. A `ref.key` that is a link, belongs to another user, or can be read by group or others (Unix), or whose access list is not owner-only (Windows), is refused at start. Audit records written by earlier versions may hold the text of a neighbour in `nearest_neighbor` and in the payload of `NEAREST_NEIGHBOR` records; on the first start of this version the gateway replaces that text with the keyed reference and clears those payloads, and a `NEAREST_NEIGHBOR` record keeps no payload at all. The live event stream (SSE), the SIEM export and webhook alerts carry metadata only, never the request payload, even when `audit.store_payloads` is on. If `data/ref.key` is damaged (wrong length) it is replaced by a new key and a warning is logged; earlier `h:` references stay in the logs but no longer match the references of new calls. Cleaning old text also compacts the audit database and the vector memory file, so the text does not stay in free pages.

If an audit record cannot be written, the gateway logs the error (never the payload) and increments the `zn_audit_write_failures_total` counter, and the call goes on. To fail closed instead, set `audit.require_write = true` (or `ZN_AUDIT_REQUIRE_WRITE=1`): a call whose audit record cannot be written is denied with a JSON-RPC error.

Every on/off environment variable (`ZN_AUDIT_STORE_PAYLOADS`, `ZN_AUDIT_REQUIRE_WRITE`, `ZN_NEURAL_BLOCKING`, `ZN_GUARDRAILS_ALERT_ONLY`, `ZN_NEURAL_ENABLED`, `ZN_NEAREST_NEIGHBOR_AUDIT`, `ZN_KMS_ALLOW_CONFIG_FALLBACK`, `ZN_KMS_RECOVER_NEW_DATA_KEY` and `ZN_FAST_BOOT`) accepts `1`, `0`, `true`, `false`, `yes`, `no`, `on` and `off`, in any capitalisation. An unset or empty variable keeps the default. Any other value (for example a typo such as `0n`) stops the gateway at start-up with a message that names the variable, so a mistyped value can never leave a security setting off.

If ZN_NAMESPACE (security.namespace) equals a tenant's namespace, that tenant also sees the local stdio calls of this process.

## AWS KMS data key

With `kms.kms_type = "aws"` and `kms.key_id` set, the audit database key is a KMS data key. The gateway creates it once (`GenerateDataKey`, AES-256, encryption context `purpose=zn-gate-audit-db-key`) and saves only its encrypted copy in `zn-kms-data-key.json`, in the same directory as the audit database (`audit.db_path`). The file is written atomically with mode 0600 and holds the KMS key id and the encrypted key, never the plaintext key. On every later start the gateway sends the encrypted key to KMS `Decrypt` and gets the same key back, so audit records written before a restart stay readable. The key needs `kms:GenerateDataKey` and `kms:Decrypt` permissions.

The gateway never replaces the key by itself. It refuses to start, with a message that names the file, when:

- the file is damaged or has an unknown version;
- KMS cannot decrypt the stored key (credentials, region, permissions or a deleted key);
- `kms.key_id` is different from the key id stored in the file.

If the old key is gone for good and you accept that earlier encrypted records are lost, start once with `ZN_KMS_RECOVER_NEW_DATA_KEY=true`: the gateway creates a new data key and overwrites the file (it logs a warning). Remove the variable afterwards. Back up `zn-kms-data-key.json` with the audit database: without it, and without KMS access to the same key, the records cannot be read.

An audit database created by an earlier release used a data key that was never saved, so its encrypted records cannot be recovered. Start with a new audit database path or remove the old database.

## Post-quantum policy signatures

A policy can carry a post-quantum signature next to its Ed25519 one (`.wasm.pqs`, base64). When `ZN_PQ_PUBLIC_KEY` is set (hex), that signature is required.

From the release after 1.11.0 it is ML-DSA-65 (FIPS 204), verified with the RustCrypto `ml-dsa` crate. To sign a policy:

- Sign the raw bytes of the `.wasm` file.
- Use pure ML-DSA-65 (not the pre-hash variant) and an empty context string.
- Write the signature as base64 to `.wasm.pqs`.

A signature made with a context or a pre-hash does not verify.

Earlier versions used Dilithium3 from the unmaintained PQClean bindings. A Dilithium3 key has the same size, but its signatures cannot be decoded as ML-DSA-65. Policies signed that way are refused until they are signed again with an ML-DSA-65 key.

## Dependency advisories that cannot be fixed yet

`cargo audit` ignores two advisories; `.cargo/audit.toml` lists them with the reason. Both say that a crate is no longer maintained, and neither crate has a drop-in replacement today:

- RUSTSEC-2024-0436, `paste`: a procedural macro that runs only at build time. It comes through `gemm`, which Candle (`candle-core`) uses.
- RUSTSEC-2025-0119, `number_prefix`: it formats numbers in command line progress bars. It comes through `indicatif`, which `cliclack` and `hf-hub` use.

`zip`, which Candle uses to read `.npz` and PyTorch `.pth` files, is at 9.3.0 and needs no exception.

## Management API authentication

Send a key or token in `X-API-Key`, in `Authorization: Bearer <value>` (`Bearer` in any letter case), or (only on `/api/v1/events` and `/mcp/ws`, for SSE and WebSocket clients) in the `api_key` or `token` query parameter, percent-encoded. Prefer the headers: query strings can end up in proxy logs. The value is checked in this order:

1. `ZN_API_KEY`: full access (super-admin). Surrounding whitespace is ignored, an empty or blank `ZN_API_KEY` counts as not set, and an empty or blank key or token never authenticates.
2. A tenant API key: the tenant's role, scoped to its namespace. Blocked tenants get 403.
3. A JWT signed with `ZN_JWT_SECRET` (HS256 only; other algorithms and unsigned tokens are rejected). The secret must be at least 32 bytes, or the gateway refuses to start (for example `openssl rand -hex 32`).

JWT claims:

| Claim | Required | Meaning |
|---|---|---|
| `sub` | yes | Who the token is for; logged when a token is refused. |
| `exp` | yes | Expiry (Unix seconds). |
| `nbf` | no | Not valid before this time (Unix seconds). |
| `roles` | yes | List of roles, exact lowercase names: `superadmin`, `admin`, `user`, `viewer`, `blocked`. The highest role applies; `blocked` overrides everything. |
| `namespace` | for every role except `superadmin` | Tenant namespace the token is scoped to. No whitespace or control characters; `global` is reserved. |

A token with a bad signature, another algorithm, past its expiry or before its `nbf` gets **401**. A correctly signed token with no usable role (missing, empty, unknown or wrongly cased roles, only `blocked`, or a tenant role without a valid namespace) gets **403**.

**Breaking change:** earlier versions of the gateway gave any valid HS256 token full super-admin access. These rules now apply:

- Tokens must carry `roles`, and `namespace` for tenant roles. Role names are case-sensitive.
- `ZN_JWT_SECRET` must be at least 32 bytes or the gateway refuses to start, so tokens signed with a shorter secret stop working.
- Tokens with an `nbf` (not before) time in the future are rejected, with 60 seconds of leeway for clock differences.
- Tenants can no longer be created in the `global` namespace or with a namespace that has whitespace.
- The gateway no longer prints a `ZN_API_KEY` taken from the environment when it seeds the default organisation.

`POST /api/v1/tenants` (super-admin only) answers **403** to other roles and **400** with `{"status":"error","error":...}` when the tenant cannot be created (invalid namespace, blank key, or a name, namespace or key already in use). Earlier versions answered 200 in both cases.

### Tenants with a blank key

Earlier versions could seed the default organisation with the hash of an empty key. This happened when `ZN_API_KEY` was set but empty (for example `ZN_API_KEY=` from an unset compose variable).

Blank keys are now refused, so that tenant can no longer authenticate. Since the database already has tenants, no new one is seeded. The gateway logs a warning at startup naming each such tenant (never a key).

To fix it, choose one of these:

- Set a non-blank `ZN_API_KEY`. It works as the legacy super-admin key.
- Give the tenant a new key in the audit database (`ZN_DB_PATH`, `zn.db` by default) while the gateway is stopped:

```bash
NEW_KEY=$(openssl rand -hex 32)
HASH=$(printf %s "$NEW_KEY" | sha256sum | cut -d' ' -f1)
sqlite3 zn.db "UPDATE tenants SET api_key_hash = '$HASH' WHERE id = '<tenant id from the warning>';"
```

### MCP WebSocket token

`ZN_MCP_WS_TOKEN` is an extra check for MCP WebSocket connections, on top of the management API authentication, sent in the `token` query parameter or the `X-MCP-Token` header. Surrounding whitespace is ignored, a blank value counts as not set (the gateway then generates a random token), and the comparison takes constant time. A generated token is saved in `zn-mcp-ws-token.txt`, in the same directory as `audit.db_path` (mode 0600; on Windows the file inherits the directory ACL). It changes on every start and is never printed, so read it from that file, or set `ZN_MCP_WS_TOKEN` to use a stable one. If the file cannot be written, the gateway refuses to start and asks you to set `ZN_MCP_WS_TOKEN`. The `token` query parameter is also read as a management API credential, which takes the first `api_key` or `token` parameter: a client that sends both should put `api_key` first, or send the MCP token in the `X-MCP-Token` header.

## Policy endpoints

`POST /api/v1/policies/upload` and `POST /api/v1/policies/delete` (super-admin only) work on `engine.policy_dir` (default `./policies_bin`), the directory the gateway loads and watches. A policy name, and an uploaded file name without its `.wasm` extension, must be 1-64 ASCII letters, digits, `.`, `-` or `_`, starting with a letter or digit. Other names are refused, and so is a policy file that resolves outside the directory through a symlink. Earlier versions wrote uploads to `./policies` and joined the name from the request to that path as given, so a name such as `../x` could write or delete a `.wasm` file outside it.

Uploads are written to a temporary file and renamed into place, so the watcher never loads a half-written policy, and a symlink at the target name is refused.

**Upgrading:** policies uploaded with an earlier version are in `./policies` and are no longer loaded. Move the `.wasm` files, with their `.wasm.sig` / `.wasm.pqs` signatures if you use them, to `engine.policy_dir` before you start the new version, for example `mv policies/*.wasm* policies_bin/`.

## Vector memory limits

The vector memory keeps at most 10,000 rows per agent, 25,000 per namespace and 100,000 per file. Set `ZN_MEMORY_MAX_AGENT_ROWS`, `ZN_MEMORY_MAX_NAMESPACE_ROWS` and `ZN_MEMORY_MAX_TOTAL_ROWS` to change them. When the file is full, the oldest rows of the namespace furthest above its fair share (the file limit divided by the namespaces that have rows) are deleted, so a namespace within its share keeps its rows and a new one can always store.

Each variable takes an integer from 1 to 100,000,000; other values are ignored with a warning and the default applies. A lowered limit is applied on the next write to each agent or namespace, so that first write can delete many old rows at once. The fair share is recalculated as namespaces appear, so a namespace that was within its share can later be above it and give up rows. With more namespaces than the file limit, each keeps at least one row, so the file can go slightly over the limit.

## Upgrading the vector memory

The per-agent vector memory is now stored in SQLite (`data/vectors/<model>_d<dim>.sqlite3`). The older Lance directories (`data/vectors/<model>_d<dim>/`) are not migrated or read and can be deleted.

Memory is scoped to a namespace: the tenant namespace of an authenticated MCP WebSocket connection, or `ZN_NAMESPACE` (default `global`) for the local stdio proxy and `zn analyze`. The agent id sent in MCP messages is not authenticated, so it only selects a memory inside the namespace. Limits:

| Limit | Default | When it is exceeded |
|---|---|---|
| Rows per agent | 10,000 | The agent's oldest rows are deleted. |
| Rows per namespace | 25,000 | The namespace's oldest rows are deleted. |
| Rows per file | 100,000 | The oldest rows of the namespace furthest above its fair share (the file limit divided by the namespaces that have rows) are deleted. |

The file limit is the only one that can delete another namespace's rows, and only those of a namespace above its fair share: a namespace within its share keeps its rows, and a new namespace can always store (see [Vector memory limits](#vector-memory-limits)).

The first time a new version opens a file written by an earlier one, it upgrades it in place (schema version 2): existing rows are assigned to the `global` namespace, since earlier versions did not record who wrote them. The first store in a namespace then trims it to its limit, which for the `global` namespace of an older file can delete many rows at once. SQLite does not shrink the file on its own; run `VACUUM` on it while the gateway is stopped to reclaim the space.

A search runs on the request path, so it is tried once and gives up after one second; the request then goes on without a nearest neighbour. Failures are logged as a warning at most once every ten minutes, and at debug level in between.

## Model download on first start

`zn start` loads a sentence embedding model for its neural check. If the folder `~/.zn/models/all-MiniLM-L6-v2` does not hold it yet, the gateway downloads `sentence-transformers/all-MiniLM-L6-v2` (about 90 MB) from `https://huggingface.co` into that folder on the first start. `zn analyze` and `zn mcp` load the same model. The download is pinned to one commit of the model repository (`1110a243fdf4706b3f48f1d95db1a4f5529b4d41`, set in `src/ai/embedder.rs`). The files `config.json`, `tokenizer.json` and `model.safetensors` must match their SHA-256 hashes; a file that does not match is deleted and downloaded again. If the download fails, the gateway stops at start-up.

To avoid the download:

- `ZN_FAST_BOOT=1` (or `true`, `yes`, `on`; `0` or `off` leaves it off, and any other word stops the start): the gateway does not load the model and runs with a stub. The neural check is off, and the gateway says so when it starts. With `neural.active_blocking` on (and `guardrails.alert_only` off) the gateway does not start, because the check that should block would be missing. For tests only.
- `"neural": {"enabled": false}` in `zn.json`: the model is not loaded and the neural check is off.
- `ZN_NEURAL_MODEL_PATH=/path/to/folder` (or `neural.model_path` in `zn.json`): the gateway loads the model from that folder. Nothing is downloaded if the three files there match their hashes, so a local copy must be byte-identical.
- `HF_ENDPOINT=<your-mirror-url>`: the gateway downloads from that server instead of huggingface.co. The server must serve the same paths, `<endpoint>/sentence-transformers/all-MiniLM-L6-v2/resolve/<commit>/<file>`.

## Build it yourself

1. Install the prerequisites:
   - Rust 1.95 or later (`cargo`); CI uses 1.99.0 and the Dockerfile builds with `rust:1-bookworm`
   - `protoc` 29 or later
   - OpenSSL / libssl-dev
2. Build the gateway from the repository root:

   ```bash
   cargo build --release
   ```

3. Check that the binary runs:

   ```bash
   ./target/release/zn --help
   ```

## Running in Docker

The root `Dockerfile` builds a small distroless image (nothing is published; build it yourself):

```bash
docker build -t zn .
docker run --rm -i zn analyze "ignore all previous instructions"
```

The server (`zn start`) needs two things inside a container. It listens on `127.0.0.1` by default, which a published port cannot reach, so set `server.bind_address` to `0.0.0.0` in a config file (the container's own address). And it reads requests on standard input, so keep stdin open with `-i`: without it the server exits at once. Set `ZN_API_KEY` too, because a random key would be written inside the container and lost when it stops:

```bash
echo '{"server":{"bind_address":"0.0.0.0"}}' > zn.json
docker run --rm -i -p 127.0.0.1:9090:9090 -e ZN_API_KEY=<your-key> -v "$PWD/zn.json:/data/zn.json:ro" zn start
curl -H "X-API-Key: <your-key>" http://127.0.0.1:9090/api/v1/health
```

`0.0.0.0` is the address inside the container. `-p 127.0.0.1:9090:9090` publishes the port on this machine's loopback only; leave out `127.0.0.1:` and every machine that can reach the host can reach the gateway.

## KMS key and the config fallback

When `kms.key_id` (or `ZN_KMS_KEY_ID`) is set, the gateway takes the audit database key from the KMS. If that key cannot be fetched, the gateway now refuses to start with a clear error instead of quietly using the key from the config.

To keep the old behaviour on purpose, set `kms.allow_config_fallback = true` (or `ZN_KMS_ALLOW_CONFIG_FALLBACK=true`). The gateway then starts with the config key and logs a warning on every start. The option is off by default. Without `kms.key_id`, nothing changes: the key from the config is used.

The gateway reads at most 16 MiB per line, from its own input and from each upstream MCP server over stdio; a longer line is dropped and answered with a JSON-RPC error.
