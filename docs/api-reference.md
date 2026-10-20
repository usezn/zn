# zn-gate API Reference

## Node.js (`zn-gate`)

<!-- snippet-test -->
```javascript
const { evaluate, redactSecrets, sanitizeToolResult } = require('zn-gate/lib/rules');
const { analyze, analyzeLocal, checkToolResult, checkToolCall, guardTool, GuardBlockError } = require('zn-gate/lib/client');
const { isCloudEnabled, usesStoredKey, usableApiKey, longInputMode, resolveEndpoint } = require('zn-gate/lib/client');
const { logEvidence, verifyEvidenceLedger } = require('zn-gate/lib/evidence');
```

The package ships TypeScript type definitions (`lib/client.d.ts`, `lib/rules.d.ts`, `lib/evidence.d.ts`); no `@types` package is needed.

### `evaluate(text, options)`
- Synchronous in-memory deterministic rule evaluation. Never touches the network.
- Options: `strict` (boolean; also blocks the heuristic rules that are advisories by default; `ZN_STRICT=1` does the same).
- Inputs over 256 KB are analysed as their first 192 KB and last 64 KB, with `truncated: true`.
- Returns: `{ verdict: 'allow' | 'block', confidence: number, rule: string, reason: string | null, engine: string, rules_version: string }`, plus `truncated: true` when the input was cut and `advisory: { rule, reason }` when an advisory rule matched on an allowed input.
- `evaluate` is also exported by `zn-gate/lib/client`.

### `analyze(text, options)`
- Prompt evaluation: runs local rules first. Queries the cloud classifier only when the user opted in, with both an API key (`apiKey` or `ZN_API_KEY`) and `ZN_CLOUD=1` or with `zn-gate connect`, and `ZN_LOCAL_ONLY` is not `true`. The text is secret-redacted locally before it is sent.
- Options: `apiKey`, `apiUrl`, `stage` (`'v30'` or `'prod'`), `timeout` (**milliseconds**; default 4000, or 12000 for text over 1,000 characters), `localOnly`, `longInput` (`'windows'` or `'off'`), `strict`.
- Returns: `Promise<{ verdict, confidence, rule, reason, engine, rules_version, mode, ... }>`. `mode` is `'hybrid-local-fastpath'` (a local rule blocked, no network), `'oss-local'` (cloud not enabled), or `'hybrid-cloud'` (the cloud answered; `secrets_redacted_before_upload` counts the redactions).
- If the cloud call fails or no key can be read, it resolves with the local result, `mode: 'oss-local'`, `fallback: true` and `cloud_error` (a message). It does not throw.

### `analyzeLocal(text, options)`
- Synchronous, local only; never touches the network, whatever the environment says. Use it when you want the result shape of `analyze` without any chance of a cloud call.
- `options` is passed to `evaluate` (for example `{ strict: true }`).
- Returns: the `evaluate` result plus `mode`: `'hybrid-local-fastpath'` when a local rule blocked, otherwise `'oss-local'`.

### `isCloudEnabled(options)`
- Synchronous. Returns `true` only when the user opted in to cloud analysis: a usable API key (`options.apiKey` or `ZN_API_KEY`) together with `ZN_CLOUD=1`, or a key saved by `zn-gate connect`. Always `false` with `options.localOnly` or `ZN_LOCAL_ONLY=true`.
- It reads at most one small config file and never the system keychain, so `true` does not promise that a saved key can be read: `analyze` then resolves with the local result, `fallback: true` and `cloud_error`.

### `usesStoredKey(options)`
- Synchronous. Returns `true` when the cloud would be used because of the key saved by `zn-gate connect`, and not because of an explicit key plus `ZN_CLOUD=1`. In that case `apiKey`, `ZN_API_KEY`, `apiUrl` and `ZN_API_URL` take no part, so an environment key is never sent along with a saved connection.
- It does not look at the local-only overrides; combine it with `isCloudEnabled`.

### `usableApiKey(value)`
- Returns the trimmed key when `value` is a string of 16 to 256 letters, digits, `.`, `_` or `-`, otherwise `null`. It rejects empty values and placeholders that were never filled in, such as `${user_config.api_key}` or `%ZN_API_KEY%`.

### `longInputMode(options)`
- Returns `'windows'` (default) or `'off'`, from `options.longInput` or `ZN_LONG_INPUT`. `'off'`, `'none'`, `'truncate'`, `'0'`, `'false'` and `'no'` (any case) give `'off'`; any other value gives `'windows'`.
- With `'windows'`, `analyze` asks the cloud classifier to read texts longer than `LONG_INPUT_MIN_CHARS` in overlapping windows instead of only the first 512 tokens.

### `resolveEndpoint(options, flags)`
- Returns the URL `analyze` posts to. Order: `options.apiUrl`, then `ZN_API_URL`, then the stage (`options.stage`, `ZN_STAGE`, default `'v30'`): `https://api.usezn.com/v30/analyze`, or `https://api.usezn.com/prod/analyze` for `'prod'`.
- `flags.stored` (default `false`): set it for a key saved by `zn-gate connect`. A custom URL is then ignored and only the stage decides, so a saved key is never sent to another host.

### Constants
- `LONG_INPUT_MIN_CHARS` (`zn-gate/lib/client`): `1000`. Text longer than this asks the cloud classifier for windowed reading, and gets the longer default timeout.
- `RULES_VERSION` (`zn-gate/lib/client` and `zn-gate/lib/rules`): the version of the built-in rule set, the same string that comes back as `rules_version` in results.
- `EVIDENCE_FILE` (`zn-gate/lib/evidence`): the default evidence log path, `~/.zn/evidence.jsonl`.

### `sanitizeToolResult(toolName, content, options)`
- Deep sanitization of external tool outputs. Blocks indirect prompt injections and redacts sensitive credentials (AWS keys, OpenAI tokens, DB passwords).
- Two call forms. With a tool name and content (`sanitizeToolResult('web_search', output, options)`), it scans the output and returns the object below. With one value and no content (`sanitizeToolResult(data)`), it only redacts secrets, walking strings, arrays and objects, and returns `{ sanitized, detections }`; each detection is `{ rule, index }` (`index` is the offset of the match).
- Options: `maskSecrets` (default `true`), `blockTruncated`, `strict`.
- Output is scanned in overlapping 256 KB windows up to 4 MB (plus the last 256 KB). `truncated` is `true` when the output was not scanned in full; pass `blockTruncated: true` or set `ZN_BLOCK_TRUNCATED=1` to block such output.
- Returns (tool name and content form): `{ tool_name, safe_to_ingest, truncated, assessment, secrets_redacted, sanitized_content }`

### `redactSecrets(text)`
- Replaces credentials in a string with placeholders such as `[REDACTED_AWS_KEY]`. Local only.
- Returns: `{ sanitized: string, detections: Array<{ rule: string, index: number }> }`. This is an object, unlike the Python function, which returns a tuple.

### `checkToolResult(toolName, content, options)`
- Local only; never touches the network. Inspects tool output before it enters the model context and always redacts secrets.
- Same scanning and `blockTruncated` option as `sanitizeToolResult`.
- Returns: `Promise<{ tool_name, safe_to_ingest, truncated, secrets_redacted, sanitized_content, assessment }>`

### `checkToolCall(toolName, args, options)`
- Synchronous and local only. Decides whether an agent tool call is safe to run. Every string in `args` (nested values and object keys, up to 10 levels deep) goes through the same rules as `evaluate`; the first block wins. Same verdicts as `check_tool_call` in the Python package.
- `options` is passed to `evaluate` (for example `{ strict: true }`).
- Returns: `{ allowed: boolean, verdict: 'allow' | 'block', confidence: number, rule: string, reason: string | null, advisory?: object }`

### `guardTool(fn, options)`
- Wraps a sync or async function as a guarded tool. The call arguments are checked with `checkToolCall` before `fn` runs; a blocked call never runs. Returns a function with the same name, `this` and (async or sync) behavior.
- `options`:
  - `name`: tool name used in messages and as the name of the returned function (default: `fn.name`, an empty string for an anonymous function; messages then say `anonymous`).
  - `onBlock`: `'throw'` (default, fail closed) throws a `GuardBlockError`; `'return'` returns `options.fallback`, or the assessment when no `fallback` is given. Any other value (a typo such as `'raise'` included) throws a `TypeError` when the function is wrapped, never later.
  - `fallback`: value returned when `onBlock` is `'return'`.
  - `checkArgs`: check the arguments (default `true`).
  - `checkResult`: also check the returned value (or the resolved value of a promise) before it is returned, with the same scanning as `sanitizeToolResult` (default `false`).
  - `maskSecrets`: redact credentials in the returned value (default `false`).
  - `blockTruncated`: with `checkResult`, block output too large to scan in full (rule `size:truncated`). `ZN_BLOCK_TRUNCATED=1` does the same for every guard.
  - `onBlockCallback(assessment, name, payload)`: called before a block is applied.
  - `strict`: passed to the rules engine.

### `GuardBlockError`

- `GuardBlockError` extends `Error` and has `assessment`, `target` (`name`, or `name:result` for a blocked result), `payload` and `code` (`'ZN_GUARD_BLOCK'`).

```javascript
const { guardTool } = require('zn-gate/lib/client');

const search = guardTool(async (query) => fetchResults(query), { name: 'search', checkResult: true });
// await search('weather in Madrid') runs; a query or a result that matches a rule throws GuardBlockError.
```

### `sanitizeToolResult`, `redactSecrets`, `verifyEvidenceLedger` and `logEvidence`
- Also exported from `zn-gate/lib/client`, so `require('zn-gate')` gives them too (the package `main` is `lib/client.js`). The `lib/rules` and `lib/evidence` paths keep working.
### `logEvidence(event, filePath, options)`
- Appends one hash-chained record to the evidence log (`filePath` defaults to `~/.zn/evidence.jsonl`). `options.lockWaitMs` sets how long to wait for the write lock (default 2000).
- Returns: the record that was written, or `null` when nothing was written (see the notes on damaged logs and the lock under `verifyEvidenceLedger`). It never throws for a log problem.

### `verifyEvidenceLedger(filePath)`
- `filePath` is optional and defaults to `~/.zn/evidence.jsonl`. A missing file counts as valid and empty.
- Returns: `{ valid: boolean, total: number, verified: number, broken_index: number | null, error: string | null }`. `total` is the number of records, `verified` how many passed before the first problem, and `broken_index` the zero-based index of the first bad record.
- Verifies the SHA-256 hash chain in `~/.zn/evidence.jsonl`. It detects accidental or partial edits; it is not tamper-proof against someone with write access to the file.
- A log that holds invalid bytes or a line that cannot be read is reported as corrupted (`valid: false` with the line number in `error`), never as a crash. Writing never restarts the chain on top of a damaged log: `logEvidence` / `log_evidence` skip the write, print a warning (the first time, then at most every 5 minutes) and return `null` / `None`, and the command carries on.
- To recover from a damaged log, move the file aside so the old one is kept for review: `mv ~/.zn/evidence.jsonl ~/.zn/evidence.damaged.jsonl` (Windows `cmd`: `move %USERPROFILE%\.zn\evidence.jsonl %USERPROFILE%\.zn\evidence.damaged.jsonl`; PowerShell: `Move-Item $env:USERPROFILE\.zn\evidence.jsonl $env:USERPROFILE\.zn\evidence.damaged.jsonl`). The next event starts a new chain. The same step is printed in the warning and by `evidence --verify`.
- Several processes can write to the same log at once (for example two agents in one project, or the Node and Python packages together). Each write takes a short lock (`~/.zn/evidence.jsonl.lock`) so the chain stays in one line. If the lock stays busy for 2 seconds, or the log cannot be written (for example, no permission), `logEvidence` / `log_evidence` skip that write, print a warning and return `null` / `None`; the command carries on. A lock file left by a crashed process is removed after 10 seconds.
- The hash of each record is taken over its compact JSON with text written as is (UTF-8). Records written by earlier Python versions, which escaped non-ASCII text as `\uXXXX`, still verify, and one log can be shared between the Node and Python packages. A `record_hash` is 64 lowercase hex characters.

---

## Python (`zn-gate`)

<!-- snippet-test -->
```python
from zn_gate import evaluate, guard, check_tool_call, check_tool_result, redact_secrets, sanitize_tool_result
from zn_gate import analyze, log_evidence, verify_evidence_ledger
from zn_gate import GuardBlockError, normalize_input, analyze_cloud, is_cloud_enabled, resolve_endpoint
from zn_gate import get_evidence_stats, export_evidence_ledger
# The submodules work too: zn_gate.rules, zn_gate.client, zn_gate.evidence
# Framework integrations live in zn_gate.integrations (see below)
```

### `evaluate(text: str, strict: bool | None = None) -> Assessment`
- Pure Python in-memory deterministic evaluation. Never touches the network.
- `strict=None` follows `ZN_STRICT`; `True` also blocks the heuristic rules that are advisories by default.
- Inputs over 256 KB are analysed as their first 192 KB and last 64 KB, with `truncated=True`.
- Returns: `Assessment(verdict, confidence, rule, reason, engine, rules_version, truncated, advisory)`. `verdict` is `'allow'` or `'block'`; `advisory` is a dict or `None`. `assessment.allowed` is a boolean and `assessment.to_dict()` gives a plain dict.

### `@guard(on_block='raise'|'return'|'custom', fallback=None, check_args=True, check_result=False, mask_secrets=False, callback=None, block_truncated=False)`
- Python decorator protecting sync and async agent functions and tool handlers.
- `on_block='raise'` raises `GuardBlockError`; `'return'` returns `fallback` (or the `Assessment` when `fallback` is `None`); `'custom'` calls `callback(assessment, function_name, payload)`.
- `on_block` must be `'raise'`, `'return'` or `'custom'` (the last calls `callback`); any other value raises `ValueError` when the decorator is created.
- With `check_result=True`, `block_truncated=True` blocks a result too large to scan in full (rule `size:truncated`); `ZN_BLOCK_TRUNCATED=1` does the same for every guard.

### `GuardBlockError(assessment, target='', payload=None)`
- Subclass of `PermissionError`, raised by `@guard`, `guarded_tool` and the framework integrations when a call or a result is blocked. The message says what was blocked, why and the next step.
- Attributes: `assessment` (an `Assessment`), `target` (what was checked, for example `name`, or `name:result` for a blocked result) and `payload` (the checked value).

<!-- snippet-test -->
```python
from zn_gate import guard, GuardBlockError

@guard()
def run_tool(command): ...

try:
    run_tool("cat ~/.ssh/id_rsa")
except GuardBlockError as e:
    print(e.assessment.rule, e.target)
```

### `check_tool_call(tool_name: str, arguments: Any = None, strict: bool | None = None) -> Assessment`
- Recursively extracts and inspects all strings in arguments for malicious commands or credentials.

### `check_tool_result(result: Any, block_truncated: bool = False, strict: bool | None = None) -> Assessment`
- Inspects external tool return values for indirect injection payloads. Long strings are scanned in overlapping windows up to 4 MB; `Assessment.truncated` is `True` when a string was not scanned in full. Pass `block_truncated=True` or set `ZN_BLOCK_TRUNCATED=1` to block such output (rule `size:truncated`); `@guard(check_result=True)` uses this check.

### `normalize_input(text: str) -> tuple[str, str]`
- The text clean-up the rules run on: removes zero-width and other invisible characters, ANSI escape sequences and inline `/* */` comments, folds full-width letters to ASCII and rejoins words split across lines. Never touches the network.
- Returns `(normalized, stripped)`. A value that is not a string gives `('', '')`.

### `redact_secrets(text: str) -> tuple[str, list[dict]]`
- Replaces credentials in a string with placeholders such as `[REDACTED_AWS_KEY]`. Local only.
- Returns a tuple `(clean_text, detections)`; each detection is `{'rule': str, 'start': int, 'end': int}` (the span of the match in the input). The Node function returns an object with `{ rule, index }` detections instead.

### `sanitize_tool_result(tool_or_result, content=None, mask_secrets=True, block_truncated=False, strict=None)`
- Two call forms, as in Node. `sanitize_tool_result(data)` redacts secrets in strings, lists, dicts and tuples and returns a **tuple** `(clean_data, detections)`, with detections shaped as for `redact_secrets`. The Node version returns `{ sanitized, detections }`.
- `sanitize_tool_result(tool_name, content)` scans the output and returns a dict `{ tool_name, safe_to_ingest, truncated, assessment, secrets_redacted, sanitized_content }` (typed as `SanitizedToolResult`), where `assessment` is an `Assessment`.

### `analyze(input_text, api_key=None, endpoint=None, timeout=None, local_only=False, long_input=None, **kwargs) -> dict`
- Synchronous (the Node function returns a Promise). Same data flow as Node: local rules first, and the cloud only when the user opted in with `ZN_API_KEY` and `ZN_CLOUD=1`, with `ZN_LOCAL_ONLY` not `true`. Text is secret-redacted before it is sent.
- `timeout` is in **seconds** (default 4.0, or 12.0 for text over 1,000 characters); the Node option is in milliseconds.
- Returns a dict with `verdict`, `confidence`, `rule`, `reason`, `engine`, `rules_version` and `mode`: `'hybrid-local-fastpath'`, `'oss-local'` or `'hybrid-cloud'`, as in Node.
- If the cloud call fails it returns the local result with `mode: 'oss-local-fallback'`, `fallback: True` and `cloud_error`. Node reports the same case as `mode: 'oss-local'` with `fallback: true`.
- `api_url` and `stage` (`'v30'` or `'prod'`) can be passed as keyword arguments, like `apiUrl` and `stage` in Node; they pick the endpoint as `resolve_endpoint` does. The `endpoint` argument wins over both.
- Unlike Node, it does not use a key saved by `zn-gate connect`: pass `api_key` or set `ZN_API_KEY` together with `ZN_CLOUD=1`.

### `analyze_cloud(input_text, api_key, endpoint_url=None, timeout=4.0, long_input=None) -> dict`
- Sends one request to the cloud classifier, with secrets redacted first, and returns the parsed response with `engine` added. It skips the local rules and the opt-in check, so call it only for a user who opted in. Unlike `analyze`, it raises on any failure (`urllib.error.URLError`, `HTTPError`, a timeout).
- `endpoint_url` defaults to `https://api.usezn.com/v30/analyze`. `timeout` is in seconds. `long_input='windows'` asks for windowed reading of long text.

### `is_cloud_enabled(api_key: str | None = None, local_only: bool = False) -> bool`
- `True` only when a key (`api_key` or `ZN_API_KEY`) is set together with `ZN_CLOUD=1`, and neither `local_only` nor `ZN_LOCAL_ONLY=true` is set. A key saved by `zn-gate connect` is not used.

### `resolve_endpoint(options: dict | None = None) -> str`
- Returns the URL `analyze` posts to. Order: `options['api_url']`, then `ZN_API_URL`, then the stage (`options['stage']`, `ZN_STAGE`, default `'v30'`): `https://api.usezn.com/v30/analyze`, or `https://api.usezn.com/prod/analyze` for `'prod'`.


### `log_evidence(event: dict, file_path: str = EVIDENCE_FILE, lock_wait: float = 2.0) -> dict | None`
- Appends one hash-chained record to the evidence log. `lock_wait` is in seconds. Returns the record, or `None` when nothing was written (see `verify_evidence_ledger`).

### `verify_evidence_ledger(file_path: str = EVIDENCE_FILE) -> dict`
- Same check and the same result as the Node function: `{'valid': bool, 'total': int, 'verified': int, 'broken_index': int | None, 'error': str | None}`. `file_path` is optional and defaults to `~/.zn/evidence.jsonl`.

### `get_evidence_stats(file_path: str = EVIDENCE_FILE, limit: int = 50) -> dict`
- Counts the records of the evidence log. Returns `{ total, blocks, allows, shadows, valid, error, top_rules, top_tools, recent }`: `top_rules` counts blocked records per rule, `top_tools` counts records per tool, and `recent` holds up to `limit` records, newest first. A missing file gives zero counts and `valid: True`; a log that cannot be read gives `valid: False` and the reason in `error`.
- The Node module `zn-gate/lib/evidence` also exports `getEvidenceStats`, but it is not typed and not part of the documented Node API.

### `export_evidence_ledger(file_path: str | None = None, format: str = 'jsonl') -> dict`
- Exports the evidence log as JSON lines or CSV, together with the result of the chain check. `file_path` defaults to `~/.zn/evidence.jsonl`; `format` is `'jsonl'` (default) or `'csv'` (any other value gives `'jsonl'`).
- Returns `{ content, format, valid, tip_hash, total }`, plus `error` when the log is damaged. `tip_hash` is the `record_hash` of the last record, or `GENESIS_HASH` for an empty log.
- The Node module `zn-gate/lib/evidence` also exports `exportEvidenceLedger`, but it is not typed and not part of the documented Node API.

### Constants
- `GENESIS_HASH`: 64 zeros, the `prev_hash` of the first record of a log.
- `EVIDENCE_FILE` (`zn_gate.evidence`): the default evidence log path, `~/.zn/evidence.jsonl`.
- `RULES_VERSION`: the version of the built-in rule set, the same string that comes back as `rules_version` in results.
- `__version__`: the installed package version.

### Framework integrations (`zn_gate.integrations`)

<!-- snippet-test -->
```python
from zn_gate.integrations import ZnGuardCallbackHandler, guarded_tool, ZnLlamaGuard, call_api
```

No framework is required to import them. Each one uses the same rules as `check_tool_call` and `check_tool_result`. `on_block` must be one of the values below; any other value raises `ValueError` when the object is created.

### `ZnGuardCallbackHandler(on_block='raise', mask_secrets=True, raise_on_injection=None)`
- LangChain and LangGraph callback handler. It checks prompts (`on_llm_start`), tool inputs (`on_tool_start`) and tool outputs (`on_tool_end`).
- `on_block`: `'raise'` (default), `'return'` or `'ignore'`. With `'raise'` a blocked prompt, tool input or tool output raises `GuardBlockError` (targets `langchain:llm_prompt`, `langchain:<tool>` and `langchain:tool_output`). With the other two values a blocked prompt or tool input is not stopped by the handler, and a blocked tool output is replaced by a notice.
- `mask_secrets`: redact credentials in the tool output the handler returns (default `True`).
- `raise_on_injection`: older switch. When it is not `None` it overrides `on_block`: `True` means `'raise'`, `False` means `'ignore'`.

### `guarded_tool(on_block='raise', mask_secrets=True, fallback=None, check_result=False, block_truncated=False, framework=None)`
- Decorator for custom agent tools (CrewAI, Pydantic AI, Google ADK or plain functions, sync or `async def`). The call arguments are checked before the tool runs; a blocked call never runs.
- `on_block`: `'raise'` (default) raises `GuardBlockError`; `'return'` returns `fallback`, or the plain block message when `fallback` is `None`. Any other value raises `ValueError` when the decorator is created.
- `mask_secrets`: redact credentials in the tool output (default `True`).
- `check_result`: also scan the output for prompt injection before the agent sees it (default `False`); a blocked output raises or returns as above. `block_truncated` blocks an output too large to scan in full (rule `size:truncated`).
- `framework`: prefix of the block target, `'<framework>:<tool>'` (default `'tool'`).

### `ZnLlamaGuard(on_block='raise', mask_secrets=True, raise_on_violation=None)`
- Query and response check for LlamaIndex. `check_query(query)` (also `on_query_start`) returns the query when it is allowed, and with `'raise'` raises `GuardBlockError` (target `llamaindex:query`) when it is blocked; the other `on_block` values let the query through. `sanitize_response(response)` redacts credentials when `mask_secrets` is `True` and returns the clean value; call it yourself, it is not run automatically.
- `on_block` accepts `'raise'` (default), `'return'` or `'ignore'`. `raise_on_violation` overrides it as `raise_on_injection` does above.

### `call_api(prompt, options=None, context=None) -> dict`
- Promptfoo provider entry point (`promptfoo_provider` is the same function). It runs `evaluate` on the prompt and returns `{ output, tokenUsage, cost, cached, metadata }`: `output` starts with `[BLOCKED]` or `[ALLOWED]`, and `metadata` has `verdict`, `rule`, `reason`, `confidence`, `latency_ms` and `allowed`. In `promptfooconfig.yaml`: `id: 'python:zn_gate.integrations.promptfoo:call_api'`.
