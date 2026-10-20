# LangChain.js and LangGraph.js with zn-gate

A small LangGraph.js agent whose tools are wrapped by zn-gate. It is the Node counterpart of [`examples/langchain-agent`](../langchain-agent). Everything runs offline: a scripted chat model replaces the LLM, so there is no API key and no network call.

What the wrapper (`guardTool` in `index.js`) does for every tool:

1. **Blocks a dangerous call.** It checks the tool name and arguments with `evaluate()` before the tool runs. A call that reads `~/.ssh/id_rsa` is refused and the model gets a short "blocked" message instead.
2. **Scrubs the output.** It passes what the tool returns through `sanitizeToolResult()` before the model sees it. Secrets are masked and a hidden prompt injection is removed.

All values in the demo are made up (the AWS key is the example from AWS's documentation).

## Requirements

- Node.js 20 or newer
- `zn-gate` 1.12.0 or newer (the example uses `evaluate` and `sanitizeToolResult` from `zn-gate/lib/rules`)

Pinned versions: `@langchain/core` 1.2.18, `@langchain/langgraph` 1.5.1, `zod` 4.6.7.

## Run it

```bash
cd examples/langchain-js
npm ci
npm start
```

Expected output:

```
[zn-gate] BLOCKED run_shell({"command":"cat ~/.ssh/id_rsa"}) rule=path:sensitive_file
[zn-gate] read_config output: safe_to_ingest=true secrets_redacted=2
...
zn-gate demo OK: dangerous call blocked, secrets scrubbed
```

## Use it with a real model

Replace `ScriptedModel` with a chat model from your provider package (for example `new ChatOpenAI(...)` or `new ChatAnthropic(...)`) and bind the tools with `model.bindTools(tools)`. The graph and the wrapper do not change.

This example is checked in CI by the `Examples smoke` workflow.
