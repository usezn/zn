# Rust gateway (legacy, not released)

The root `src/` directory contains the original Rust gateway (`zn`) from the 1.0.0 line: an HTTP management API and MCP proxy on `localhost:9090`, a rules engine, an optional local ONNX classifier (Candle), a SQLite audit log, WASM policies and a terminal UI.

It is **experimental** and **not distributed**: nothing you install with `npx zn-gate`, `npm install zn-gate`, `pip install zn-gate` or the agent plugin contains or starts it. It is kept for reference and for future work on a local classifier. It is not published on crates.io, has no published container image and is not part of the npm or PyPI packages. CI builds it, runs its tests, clippy and rustfmt, and checks its dependencies with `cargo audit` (`.github/workflows/rust.yml`). `zn mcp` exposes two MCP tools: `analyze_prompt` and `version`.

The Rust gateway reads `ZN_API_KEY` as the key for its own management API. It never contacts `api.usezn.com`.

On first start, with an empty database, the gateway seeds a default organisation with a super-admin key: `ZN_API_KEY` if it is set, otherwise a random key. A random key is written to `zn-superadmin-key.txt` next to the audit database (`zn.db` by default), readable only by your user (mode 0600 on Unix; on Windows the file inherits the permissions of its directory). Copy it somewhere safe, then delete the file. The key is never printed, so it does not end up in terminal scrollback or container logs; earlier versions printed a generated key to stdout. If the file cannot be written, the gateway does not start and seeds nothing.

> For agent protection (Claude Code, Codex CLI, Cursor, OpenCode, LangChain, CrewAI), use `zn-gate` (Node.js) or `zn-gate` on PyPI (Python). They need no compilation.

## Hardening (October 2026)

A review of an older snapshot of this gateway found issues that only affect someone who builds `src/` and runs `zn start` themselves. Most were already fixed; these changed now:

- **Bans per tenant.** The reputation and ban list is kept per namespace (WebSocket tenant or the configured namespace) and agent id, so a tenant can no longer ban another tenant's agent ids (such as the default `anonymous`), and `/api/v1/reputation` shows a tenant only its own namespace. The agent id in a message is a label, not an identity, and is cut to 128 characters.
- **Sanitized images are forwarded.** With `visual_pii_redaction` on, an allowed tool call now carries the sanitized arguments (metadata stripped), the same ones that were checked and stored in the audit vault, instead of the original frame, in the place they were read from (the rebuilt frame may list its keys in another order). If the frame cannot be rebuilt, the call is refused.
- **Bounded WebSocket messages.** `/mcp/ws` closes a connection whose message or frame is over 1 MiB (the library default was 64 MiB).
- **Query-string credentials only for SSE and WebSocket.** The `api_key` and `token` query parameters are accepted only on `/api/v1/events` and `/mcp/ws`, where a browser client cannot send headers; on every other route a credential must come in a header.

Known limits that remain, because the gateway is not distributed: the OCR check of images uses a fixed list of phrases and recognises only `data:image/...;base64,` images; the audit vault, the consensus queue and the loop breaker have no size or age limit; a policy upload is written before it is verified; and the management API has no TLS of its own (it listens on `127.0.0.1`; outside loopback, put it behind a TLS proxy).

## Post-quantum policy signatures

A policy can carry a post-quantum signature next to its Ed25519 one (`.wasm.pqs`, base64). When `ZN_PQ_PUBLIC_KEY` is set (hex), that signature is required. From the release after 1.11.0 it is ML-DSA-65 (FIPS 204), verified with the RustCrypto `ml-dsa` crate. Sign the raw bytes of the `.wasm` file with pure ML-DSA-65 (not the pre-hash variant) and an empty context string, and write the signature as base64 to `.wasm.pqs`; a signature made with a context or a pre-hash does not verify. Earlier versions used Dilithium3 from the unmaintained PQClean bindings: a Dilithium3 key has the same size, but its signatures cannot be decoded as ML-DSA-65, so policies signed that way are refused until they are signed again with an ML-DSA-65 key.

## Dependency advisories that cannot be fixed yet

`cargo audit` ignores three advisories in `zip` 7.2.0 (RUSTSEC-2026-0367, RUSTSEC-2026-0368 and RUSTSEC-2026-0369); `.cargo/audit.toml` lists them with the reason. `zip` comes only through Candle (`candle-core`), and no Candle release accepts the fixed `zip` 9 yet: the latest, 0.11.0, needs `zip` 8. All three are in `extract()`, which unpacks an archive to disk. Candle only opens archives to read named entries from `.npz` and PyTorch `.pth` files, and the gateway loads neither kind. When a Candle release accepts `zip` 9, Candle and `zip` are updated and the three entries are removed.

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

**Breaking change:** earlier versions of the gateway gave any valid HS256 token full super-admin access. Tokens must now carry `roles`, and `namespace` for tenant roles. Role names are case-sensitive. `ZN_JWT_SECRET` must be at least 32 bytes or the gateway refuses to start, so tokens signed with a shorter secret stop working. Tokens with an `nbf` (not before) time in the future are rejected, with 60 seconds of leeway for clock differences. Tenants can no longer be created in the `global` namespace or with a namespace that has whitespace, and the gateway no longer prints a `ZN_API_KEY` taken from the environment when it seeds the default organisation.

`POST /api/v1/tenants` (super-admin only) answers **403** to other roles and **400** with `{"status":"error","error":...}` when the tenant cannot be created (invalid namespace, blank key, or a name, namespace or key already in use). Earlier versions answered 200 in both cases.

### Tenants with a blank key

Earlier versions could seed the default organisation with the hash of an empty key when `ZN_API_KEY` was set but empty (for example `ZN_API_KEY=` from an unset compose variable). Blank keys are now refused, so that tenant can no longer authenticate, and since the database already has tenants no new one is seeded. The gateway logs a warning at startup naming each such tenant (never a key). To fix it, either set a non-blank `ZN_API_KEY` (it works as the legacy super-admin key), or give the tenant a new key in the audit database (`ZN_DB_PATH`, `zn.db` by default) while the gateway is stopped:

```bash
NEW_KEY=$(openssl rand -hex 32)
HASH=$(printf %s "$NEW_KEY" | sha256sum | cut -d' ' -f1)
sqlite3 zn.db "UPDATE tenants SET api_key_hash = '$HASH' WHERE id = '<tenant id from the warning>';"
```

### MCP WebSocket token

`ZN_MCP_WS_TOKEN` is an extra check for MCP WebSocket connections, on top of the management API authentication, sent in the `token` query parameter or the `X-MCP-Token` header. Surrounding whitespace is ignored, a blank value counts as not set (the gateway then generates a random token), and the comparison takes constant time. The `token` query parameter is also read as a management API credential, which takes the first `api_key` or `token` parameter: a client that sends both should put `api_key` first, or send the MCP token in the `X-MCP-Token` header.

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

## Building from Source

### Prerequisites
- Rust 1.95 or later (`cargo`); CI uses 1.99.0 and the Dockerfile builds with `rust:1-bookworm`
- `protoc` 29 or later
- OpenSSL / libssl-dev

```bash
cargo build --release
./target/release/zn --help
```
