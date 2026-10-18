# zn-gate API Reference

## Node.js (`zn-gate`)

```javascript
const { evaluate, redactSecrets, sanitizeToolResult } = require('zn-gate/lib/rules');
const { analyze, checkToolResult } = require('zn-gate/lib/client');
const { logEvidence, verifyEvidenceLedger } = require('zn-gate/lib/evidence');
```

### `evaluate(text, options)`
- Synchronous in-memory deterministic rule evaluation.
- Returns: `{ verdict: 'allow' | 'block', confidence: number, rule: string, reason: string | null }`

### `analyze(text, options)`
- Prompt evaluation: runs local rules first. Queries the cloud classifier only when the user opted in, with both an API key (`apiKey` or `ZN_API_KEY`) and `ZN_CLOUD=1` or with `zn-gate connect`, and `ZN_LOCAL_ONLY` is not `true`. The text is secret-redacted locally before it is sent.
- Returns: `Promise<AssessmentResult>`

### `sanitizeToolResult(toolName, content, options)`
- Deep sanitization of external tool outputs. Blocks indirect prompt injections and redacts sensitive credentials (AWS keys, OpenAI tokens, DB passwords).
- Output is scanned in overlapping 256 KB windows up to 4 MB (plus the last 256 KB). `truncated` is `true` when the output was not scanned in full; pass `blockTruncated: true` or set `ZN_BLOCK_TRUNCATED=1` to block such output.
- Returns: `{ tool_name, safe_to_ingest, truncated, assessment, secrets_redacted, sanitized_content }`

### `checkToolResult(toolName, content, options)`
- Local only; never touches the network. Inspects tool output before it enters the model context and always redacts secrets.
- Same scanning and `blockTruncated` option as `sanitizeToolResult`.
- Returns: `Promise<{ tool_name, safe_to_ingest, truncated, secrets_redacted, sanitized_content, assessment }>`

### `verifyEvidenceLedger(filePath)`
- Verifies the SHA-256 hash chain in `~/.zn/evidence.jsonl`. It detects accidental or partial edits; it is not tamper-proof against someone with write access to the file.
- A log that holds invalid bytes or a line that cannot be read is reported as corrupted (`valid: false` with the line number in `error`), never as a crash. Writing never restarts the chain on top of a damaged log: `logEvidence` / `log_evidence` skip the write, print a warning (the first time, then at most every 5 minutes) and return `null` / `None`, and the command carries on.
- To recover from a damaged log, move the file aside so the old one is kept for review: `mv ~/.zn/evidence.jsonl ~/.zn/evidence.damaged.jsonl` (Windows `cmd`: `move %USERPROFILE%\.zn\evidence.jsonl %USERPROFILE%\.zn\evidence.damaged.jsonl`; PowerShell: `Move-Item $env:USERPROFILE\.zn\evidence.jsonl $env:USERPROFILE\.zn\evidence.damaged.jsonl`). The next event starts a new chain. The same step is printed in the warning and by `evidence --verify`.
- Several processes can write to the same log at once (for example two agents in one project, or the Node and Python packages together). Each write takes a short lock (`~/.zn/evidence.jsonl.lock`) so the chain stays in one line. If the lock stays busy for 2 seconds, or the log cannot be written (for example, no permission), `logEvidence` / `log_evidence` skip that write, print a warning and return `null` / `None`; the command carries on. A lock file left by a crashed process is removed after 10 seconds.
- The hash of each record is taken over its compact JSON with text written as is (UTF-8). Records written by earlier Python versions, which escaped non-ASCII text as `\uXXXX`, still verify, and one log can be shared between the Node and Python packages. A `record_hash` is 64 lowercase hex characters.

---

## Python (`zn-gate`)

```python
from zn_gate import evaluate, guard, check_tool_call, check_tool_result, redact_secrets
from zn_gate.client import analyze
from zn_gate.evidence import verify_evidence_ledger
```

### `evaluate(text: str) -> Assessment`
- Pure Python in-memory deterministic evaluation. Never touches the network.
- Inputs over 256 KB are analysed as their first 192 KB and last 64 KB, with `truncated=True`.
- Returns: `Assessment(verdict='allow'|'block', confidence=1.0, rule='...', reason='...')`

### `@guard(on_block='raise'|'return', check_args=True, check_result=False, mask_secrets=False, block_truncated=False)`
- Python decorator protecting sync and async agent functions and tool handlers.
- With `check_result=True`, `block_truncated=True` blocks a result too large to scan in full (rule `size:truncated`); `ZN_BLOCK_TRUNCATED=1` does the same for every guard.

### `check_tool_call(tool_name: str, arguments: Any) -> Assessment`
- Recursively extracts and inspects all strings in arguments for malicious commands or credentials.

### `check_tool_result(result: Any, block_truncated: bool = False) -> Assessment`
- Inspects external tool return values for indirect injection payloads. Long strings are scanned in overlapping windows up to 4 MB; `Assessment.truncated` is `True` when a string was not scanned in full. Pass `block_truncated=True` or set `ZN_BLOCK_TRUNCATED=1` to block such output (rule `size:truncated`); `@guard(check_result=True)` uses this check.
