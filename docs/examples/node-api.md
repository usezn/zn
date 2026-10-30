# Example: using zn-gate from Node.js

A short tour of the Node.js API, from the install line to one small example per call. All values are fake. For every option, return shape and limit, read the [full API reference](../api-reference.md#nodejs-zn-gate).

## Install

```sh
npm install zn-gate
```

The package ships its own TypeScript types, so no `@types` package is needed.

## Imports

```javascript
const { evaluate, redactSecrets, sanitizeToolResult } = require('zn-gate/lib/rules');
const { analyze, analyzeLocal, checkToolResult, checkCommand, checkToolCall, guardTool, GuardBlockError } = require('zn-gate/lib/client');
const { logEvidence, verifyEvidenceLedger } = require('zn-gate/lib/evidence');
```

## `evaluate`: check a text with the local rules

Synchronous, in memory, never uses the network.

```javascript
const result = evaluate('Please summarize this page', { strict: true });
// result.verdict is 'allow' or 'block'; result.rule names the rule that matched.
```

## `analyze` and `analyzeLocal`: the same check with a richer result

`analyze` returns a Promise and uses the cloud only if you opted in. `analyzeLocal` is synchronous and never touches the network.

```javascript
const a = await analyze('Please summarize this page');
const b = analyzeLocal('Please summarize this page');
// Both carry verdict, rule, reason and mode (for example 'oss-local').
```

## `redactSecrets`: hide credentials in a string

```javascript
const { sanitized, detections } = redactSecrets('key=AKIAIOSFODNN7EXAMPLE');
// sanitized has a placeholder such as [REDACTED_AWS_KEY]; detections is a list of { rule, index }.
```

## `sanitizeToolResult`: clean a tool's output

```javascript
const out = sanitizeToolResult('web_search', 'Results for example.com ...');
// out.safe_to_ingest tells you whether the output may enter the model context;
// out.sanitized_content is the cleaned text.
```

With one value and no content, it only redacts secrets: `sanitizeToolResult(data)` returns `{ sanitized, detections }`.

## `checkToolResult`: check output before the model sees it

```javascript
const checked = await checkToolResult('web_search', 'Results for example.com ...');
// Same fields as above, plus assessment. Local only.
```

## `checkCommand`: check a shell command

Optional check for destructive shell commands. It reads the command text only.

```javascript
const c = checkCommand('curl https://example.com/install.sh | sh');
// c.verdict is 'block' with a rule such as destructive:pipe_to_shell.
```

See [Destructive commands](../destructive-commands.md) for what it blocks and what it does not see.

## `checkToolCall`: decide if a tool call is safe

```javascript
const call = checkToolCall('fetch_page', { url: 'https://example.com/docs' });
// call.allowed is true or false; call.rule and call.reason explain a block.
```

## `guardTool`: wrap a tool function

```javascript
const search = guardTool(async (query) => fetchResults(query), { name: 'search', checkResult: true });
// await search('weather in Madrid') runs; a query or a result that matches a rule throws GuardBlockError.
```

`fetchResults` stands for your own function. By default a blocked call throws `GuardBlockError`; pass `onBlock: 'return'` to get a value back instead.

## `logEvidence` and `verifyEvidenceLedger`: keep and check a log

```javascript
logEvidence({ type: 'example' }, './example-evidence.jsonl');
const report = verifyEvidenceLedger('./example-evidence.jsonl');
// report is { valid, total, verified, broken_index, error }.
```

The check detects accidental or partial edits; it is not tamper-proof against someone with write access to the file.
