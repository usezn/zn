# Example: the settings of the zn gateway

The zn gateway (`zn start`, see [the Rust gateway](../rust-core.md)) reads its settings from a JSON file. This page lists every key `zn init` writes into that file, with its default, and shows what the gateway says when a key is misspelled. The defaults and the messages were captured from the real `zn` program built from this repository, in an empty throwaway folder. The one-line meanings come from the comments in the source file `src/config/mod.rs`, shortened. The npm and PyPI `zn-gate` packages do not read this file.

## Create the file

```bash
zn init
```

`zn init` writes `zn.json` in the current folder, with every setting at its default. Without `--config`, `zn start` looks in the current folder for `zn.json`, then `zn.config.json`, then `.zn.json`. With `--config <file>` the file must exist and end in `.json`.

Environment variables override the file (the ones the source reads are listed below). `zn start --port`, `--api-key` and `--db-path` override both.

## The keys

Defaults are the values `zn init` wrote. A key you leave out takes the same default (`siem.batch_size` is the exception: the file from `zn init` has `0`, and a `siem` section without the key uses `10` in the source). `api_key`, `jwt_secret`, `mcp_ws_token`, `encryption_key` and the SIEM token are never written with a value by `zn init`.

### Top level and `server`

| Key | Default | Meaning |
|---|---|---|
| `environment` | `"development"` | `development` or `production`. With `production` and no API key, the gateway logs a warning that the management API is unprotected. Env: `ZN_ENV` |
| `server.port` | `9090` | Management API port. Env: `ZN_PORT` |
| `server.bind_address` | `"127.0.0.1"` | Address it listens on. Set `0.0.0.0` in a container |
| `server.channel_capacity` | `100` | Broadcast channel capacity |
| `server.ws_max_message_bytes` | `1048576` | Largest WebSocket message; a larger one closes the connection |
| `server.ws_max_frame_bytes` | `1048576` | Largest single WebSocket frame |
| `server.session_idle_timeout_secs` | `900` | Seconds without a byte before a connection is closed (`0` = the default) |
| `server.write_timeout_secs` | `30` | Seconds a write to a client that does not read may block (`0` = the default) |

### `security`

| Key | Default | Meaning |
|---|---|---|
| `security.api_key` | `null` | API key for authentication. Env: `ZN_API_KEY` |
| `security.allowed_origins` | `localhost` and `127.0.0.1` on ports 5173 and 9090 | Allowed CORS origins. Env: `ZN_ALLOWED_ORIGINS` |
| `security.rate_limit_enabled` | `true` | Rate limiting on or off |
| `security.rate_limit_per_minute` | `60` | Requests per minute per client |
| `security.namespace` | `null` | Multi-tenant namespace. Env: `ZN_NAMESPACE` |
| `security.jwt_secret` | `null` | Secret for JWT validation. Env: `ZN_JWT_SECRET` |
| `security.mcp_ws_token` | `null` | Token for MCP WebSocket authentication. Env: `ZN_MCP_WS_TOKEN` |

### `engine`

| Key | Default | Meaning |
|---|---|---|
| `engine.gas_limit` | `10000000` | Gas limit for a WASM policy run. Env: `ZN_GAS_LIMIT` |
| `engine.memory_limit_mb` | `128` | Memory limit for WASM, in MB. Env: `ZN_MEMORY_LIMIT` |
| `engine.timeout_ms` | `1000` | Execution timeout, in milliseconds. Env: `ZN_TIMEOUT` |
| `engine.allowed_policy_hashes` | `[]` | Allowed policy SHA-256 hashes (hex). Env: `ZN_POLICY_HASHES` |
| `engine.signing_public_key` | `null` | Ed25519 public key for signature checks (hex). Env: `ZN_SIGNING_PUBLIC_KEY` |
| `engine.policy_dir` | `"./policies_bin"` | Policy folder |

### `audit`, `siem`, `kms`, `webhooks`

| Key | Default | Meaning |
|---|---|---|
| `audit.db_path` | `"zn.db"` | Database file. Env: `ZN_DB_PATH` |
| `audit.max_logs_in_memory` | `50` | Logs kept in memory for the dashboard |
| `audit.encryption_enabled` | `false` | Encrypt the database (needs a key) |
| `audit.encryption_key` | `null` | Database encryption key. Env: `ZN_DB_KEY` (also turns encryption on) |
| `audit.store_payloads` | `false` | Keep the scrubbed request of each audited call; needs `ZN_DB_KEY`. Env: `ZN_AUDIT_STORE_PAYLOADS` |
| `audit.require_write` | `false` | Deny a call when its audit record cannot be written. Env: `ZN_AUDIT_REQUIRE_WRITE` |
| `siem.endpoint` | `null` | External SIEM endpoint (HTTP or HTTPS). Env: `ZN_SIEM_ENDPOINT` |
| `siem.token` | `null` | Token for the SIEM. Env: `ZN_SIEM_TOKEN` |
| `siem.batch_size` | `0` | Export batch size |
| `kms.kms_type` | `"local"` | Which KMS: `local`, `aws`, `gcp` or `vaults` (source comment). Env: `ZN_KMS_TYPE` |
| `kms.key_id` | `null` | Key ID or ARN. Env: `ZN_KMS_KEY_ID` |
| `kms.region` | `null` | Region, if the KMS uses one |
| `kms.allow_config_fallback` | `false` | Start with the config key if the KMS key cannot be fetched. See [the Rust gateway](../rust-core.md#kms-key-and-the-config-fallback) |
| `webhooks` | `[]` | A list of alert webhooks. Each item has `url`, `webhook_type` (`slack`, `discord` or `generic`, default `generic`), `event_filter` and `status_filter` (lists; empty means all) and `enabled` (default `true`) |

### Detection settings

| Key | Default | Meaning |
|---|---|---|
| `neural.enabled` | `true` | Neural analysis on or off. Env: `ZN_NEURAL_ENABLED` |
| `neural.threshold` | `1.2` | Anomaly score for blocking. Env: `ZN_NEURAL_THRESHOLD` |
| `neural.active_blocking` | `false` | Block requests over the threshold. Env: `ZN_NEURAL_BLOCKING` |
| `neural.classifier_threshold` | `0.5` | Classifier probability threshold (0.0 to 1.0) for models that ship a `head.json` |
| `neural.model_id` | `"all-MiniLM-L6-v2"` | Embedding model |
| `neural.model_path` | `"~/.zn/models/all-MiniLM-L6-v2"` | Folder for the model files |
| `neural.dim` | `384` | Embedding size; must match the model |
| `fusion.enabled` | `false` | Fusion gate: block when a rule hits or the neural score reaches `tau` |
| `fusion.tau` | `0.623` | Threshold on the head probability, 0 to 1 |
| `fusion.model_path` | `"~/.zn/models/zn-minilm-l6-v2-sec-1787474325"` | Folder with the model, tokenizer and `head.json` |
| `fusion.model_id` | `"zn-minilm-l6-v2-sec-1787474325"` | Model version id |
| `managed_rules.pii_redaction` | `true` | PII redaction |
| `managed_rules.lfi_protection` | `true` | Local file inclusion protection |
| `managed_rules.sql_injection` | `true` | SQL injection protection |
| `managed_rules.prompt_injection` | `true` | Prompt injection protection |
| `managed_rules.restricted_commands` | `true` | Block common dangerous system commands |
| `managed_rules.visual_pii_redaction` | `false` | OCR and visual PII redaction for images |
| `loop_breaker.enabled` | `true` | Detect endless tool loops |
| `loop_breaker.max_repeats` | `3` | Times the same tool and arguments may repeat |
| `loop_breaker.window_seconds` | `60` | Window for the repeat count |
| `caching.enabled` | `false` | Cache tool results |
| `caching.ttl_seconds` | `300` | Cache lifetime, 0 to one year |
| `consensus.enabled` | `false` | Require several approvals for critical tools |
| `consensus.critical_tools` | `[]` | Tool patterns that need approval (for example `delete_file`) |
| `consensus.required_signatures` | `2` | Approvals needed |
| `consensus.neural_as_witness` | `true` | The neural check may count as one witness when risk is low |
| `consensus.pending_ttl_secs` | `900` | Seconds a proposed action stays valid (`0` = the default) |
| `guardrails.alert_only` | `true` | Neural anomalies alert and do not block. Env: `ZN_GUARDRAILS_ALERT_ONLY` |
| `guardrails.paranoia_level` | `1` | 1 to 5. Env: `ZN_PARANOIA_LEVEL` |
| `guardrails.min_samples` | `50` | Samples before the false-positive guard can roll back. Env: `ZN_MIN_SAMPLES` |
| `guardrails.fpr_margin` | `0.02` | False-positive margin that triggers a rollback. Env: `ZN_FPR_MARGIN` |
| `guardrails.nearest_neighbor_audit` | `true` | Log nearest-neighbor audit entries. Env: `ZN_NEAREST_NEIGHBOR_AUDIT` |

## A misspelled key

zn checks the file against this list. A key it does not know is ignored with a warning, and the gateway starts. With `{"server":{"port":9191,"bind_adress":"0.0.0.0"},"enviroment":"production"}`, `zn start --config bad.json` printed:

```text
▲  ~/bad.json: unknown setting "enviroment" was ignored, did you mean "environment"?
▲  ~/bad.json: unknown setting "server.bind_adress" was ignored, did you mean "server.bind_address"?
```

So a typo in `server.bind_address` leaves the gateway listening on `127.0.0.1`. Read the start-up lines after you edit the file. Keys that start with `_` or `$` (comments, `$schema`) are not reported.

A misspelled key inside `security` or `audit` is an error, because ignoring it would quietly weaken a security setting. With `{"security":{"rate_limit_per_minut":30}}`, the gateway did not start and printed:

```text
Error: ~/bad2.json: unknown setting "security.rate_limit_per_minut". Settings in the security and audit sections are not ignored, because a typo would silently weaken them, so zn did not start; did you mean "security.rate_limit_per_minute"?
```

## More

- [The Rust gateway](../rust-core.md)
- [Troubleshooting `zn start`](../troubleshooting.md)
