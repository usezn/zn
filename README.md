<p align="center">
  <a href="https://usezn.com">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/brand/zn-banner-dark.png">
      <source media="(prefers-color-scheme: light)" srcset="assets/brand/zn-banner-light.png">
      <img src="assets/brand/zn-banner-light.png" alt="zn" width="100%">
    </picture>
  </a>
</p>

<h1 align="center">zn-gate</h1>

<p align="center">
  <strong>Use AI coding agents without exposing your secrets, your data or your systems.</strong><br/>
  An open-source security layer that runs on your machine, between your agent and the tools and content it touches.
</p>

<p align="center">
  <a href="https://github.com/usezn/zn/actions/workflows/ci.yml"><img src="https://github.com/usezn/zn/actions/workflows/ci.yml/badge.svg" alt="CI"/></a>
  <a href="https://www.npmjs.com/package/zn-gate"><img src="https://img.shields.io/npm/v/zn-gate?color=cb3837&logo=npm&logoColor=white" alt="npm version"/></a>
  <a href="https://pypi.org/project/zn-gate/"><img src="https://img.shields.io/pypi/v/zn-gate?color=3775a9&logo=pypi&logoColor=white" alt="PyPI version"/></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License: MIT"/></a>
</p>

<p align="center">
  <a href="https://usezn.com/docs">Docs</a> ·
  <a href="packages/zn-gate/README.md">npm package</a> ·
  <a href="packages/zn-gate-py/README.md">Python package</a> ·
  <a href="SECURITY.md">Security</a> ·
  <a href="https://discord.gg/WngUHPsA9D">Discord</a>
</p>

---

**For:** developers using Claude Code, Codex CLI, Cursor, OpenCode or any MCP client, and teams building agents with MCP, LangChain, CrewAI or LlamaIndex.

**What it does today:** checks what your agent reads and calls for prompt injection, redacts secrets from tool output before the model sees it, and audits prompts, skills and configs. Runs locally, needs no account, has zero runtime dependencies.

## Install

Pick your agent. Each command adds zn-gate as an MCP server (Node.js 18+).

**Claude Code**
```bash
claude mcp add zn-gate -- npx -y zn-gate mcp
```

**Codex CLI**
```bash
codex mcp add zn-gate -- npx -y zn-gate mcp
```

**Cursor**: add to `~/.cursor/mcp.json`
```json
{ "mcpServers": { "zn-gate": { "command": "npx", "args": ["-y", "zn-gate", "mcp"] } } }
```

**OpenCode**: add to `~/.config/opencode/opencode.json`
```json
{ "mcp": { "zn-gate": { "type": "local", "command": ["npx", "-y", "zn-gate", "mcp"], "enabled": true } } }
```

**Protect the MCP servers you already use.** `init` finds them in your agent configs, writes a backup, and wraps each local server with the zn-gate proxy:
```bash
npx -y zn-gate init --dry-run   # preview
npx -y zn-gate init             # wrap (backup first)
npx -y zn-gate init --revert    # undo
```
It reads Claude Desktop, Claude Code (`~/.claude.json`), Cursor (`~/.cursor/mcp.json`), Codex CLI (`~/.codex/config.toml`) and OpenCode (`~/.config/opencode/opencode.json`). [Full list and rules](packages/zn-gate/README.md#wrap-the-mcp-servers-you-already-use).

**Python**
```bash
pip install zn-gate
```

## Check that it works

Send a tool output with a fake AWS key (AWS's documentation example) and a database password through zn-gate, exactly as your agent would. Requires zn-gate 1.4.1 or later.

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"check_tool_result","arguments":{"tool_name":"read_file","content":"AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\nDATABASE_URL=postgres://app:hunter2@db:5432/main"}}}' \
  | npx -y zn-gate@latest mcp | jq -r '.result.content[0].text'
```

`jq` only pretty-prints; without it, look for `sanitized_content` in the raw JSON. That field is what the model would see:

```text
"secrets_redacted": 2,
"sanitized_content": "AWS_ACCESS_KEY_ID=[REDACTED_AWS_KEY]\nDATABASE_URL=postgres://app:[REDACTED_DB_PASSWORD]@db:5432/main"
```

Nothing was sent over the network. Python equivalent:

```bash
python -c "from zn_gate import sanitize_tool_result as s; print(s('read_file', 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE')['sanitized_content'])"
```

Then run the local self-test (51 curated vectors: 26 attacks, 25 benign):
```bash
npx -y zn-gate test
```

## What each piece does

Where zn-gate sits in a tool call, as an MCP server or as the `shield` proxy around other servers:

```mermaid
sequenceDiagram
    participant A as Agent
    participant Z as zn-gate (on your machine)
    participant T as Tool or MCP server
    A->>Z: analyze_prompt
    Z-->>A: allow, or block with the rule that fired
    A->>Z: check_tool_call (name, arguments)
    Z-->>A: allow with secrets masked, or block
    A->>T: run the tool
    T-->>Z: output (check_tool_result, or through shield)
    Z-->>A: output with secrets redacted, or neutralized if it carries an injection
```

### Scrubber: secrets stay out of the model's context
- **Today:** redacts AWS keys, OpenAI and Anthropic keys, GitHub tokens, JWTs, private keys and database URL passwords in everything that passes through zn-gate: tool output checked with `check_tool_result`, tool arguments checked with `check_tool_call`, and output of MCP servers wrapped by `zn-gate shield` / `init`. Python: `sanitize_tool_result`, `@guard(mask_secrets=True)` and the framework integrations.
- **Not covered today:** your agent's built-in tools (for example a native file read in Claude Code) unless their output goes through zn-gate.
- **Roadmap:** personal data (PII) detection; hooks for agents' built-in tools; stable placeholders (`__ZN_AWS_KEY_1__`) backed by a local encrypted vault.

### Galvanize: prompt-injection detection
- **Today, local:** a deterministic rules engine (signatures plus normalization against homoglyphs, zero-width characters, BiDi overrides, comment splicing and Base64) checks prompts, tool arguments, tool output and MCP tool descriptions.
- **Today, optional cloud:** the Galvanize-60M classifier ([open weights on Hugging Face](https://huggingface.co/usezn/Galvanize-60M), Apache-2.0) can also check prompts sent to `analyze_prompt`, only if you set `ZN_CLOUD=1` and `ZN_API_KEY`.
- **Roadmap:** running Galvanize-60M locally inside zn-gate; published held-out results with method and data.

### Scan: audit what your agent is about to trust
- **Today:** `zn-gate scan <path>` audits prompt templates, `AGENTS.md` / `SKILL.md` files and configs for injection traps and leaked secrets (exit code 1 on findings, for CI). The same check runs as a [GitHub Action](#github-action). MCP servers can be checked on the web at [usezn.com/scan](https://usezn.com/scan).
- **Roadmap:** auditing MCP servers and skills from the CLI before you add them.

## What leaves your machine

**Nothing, by default.**

```mermaid
flowchart LR
    subgraph local["Your machine"]
        A["Agent"]
        Z["zn-gate<br/>rules engine + secret redaction"]
        T["Tools and MCP servers<br/>files, shell, web, databases"]
    end
    C["api.usezn.com<br/>Galvanize-60M classifier"]
    A -- "tool calls and prompts" --> Z
    Z -- "allowed calls, secrets masked" --> T
    T -- "tool output" --> Z
    Z -- "redacted output, verdicts" --> A
    Z -. "prompts only, redacted,<br/>only with ZN_CLOUD=1 and ZN_API_KEY" .-> C
```

| Data | Evaluated | Sent anywhere? |
|---|---|---|
| Tool output (`check_tool_result`, `shield`) | Locally | **Never**, in any configuration |
| Tool-call arguments (`check_tool_call`, `shield`) | Locally | **Never**, in any configuration |
| MCP tool and parameter descriptions (`shield`) | Locally | **Never**, in any configuration |
| Prompts (`analyze_prompt`, `zn-gate analyze`, Python `analyze()`) | Locally | Only if you set **both** `ZN_CLOUD=1` and `ZN_API_KEY`. Secrets are redacted locally before sending. |

`ZN_API_KEY` alone enables nothing. `ZN_LOCAL_ONLY=true` overrides `ZN_CLOUD=1`. `npx -y zn-gate status` prints what your configuration sends.

> **1.4.0 and earlier:** with `ZN_API_KEY` set, the Node package sent tool output and tool-call arguments to `api.usezn.com` without redaction. 1.4.1 removes that path. Details in the [CHANGELOG](CHANGELOG.md).

## Performance and accuracy

We only publish numbers we can reproduce, with the method next to them.

- **Latency of the local engine:** one table by input size, with hardware, date and the script to reproduce it (`bench/bench_by_size.js`), in the [npm package README](packages/zn-gate/README.md#performance-local-rules-engine-no-network). Short summary from that run: about 0.01 ms for a 200 B prompt, 0.3 ms for a 4 KB tool output with redaction, about 4 ms for 64 KB with redaction (p50).
- **Self-test:** 51 curated vectors pass. That is a smoke test, not a detection or false-positive rate.
- **Known limitation:** on whole source files, the current normalizer produces false positives on ordinary code comments. Not fixed in 1.4.1. Until it is, use `check_tool_result` for web and third-party content rather than your own repository files.
- **Detection rates:** none published yet. We will publish Galvanize results on a held-out test set, with method and data, before quoting a number.

## Configuration

| Variable | Default | Effect |
|---|---|---|
| `ZN_CLOUD` | off | `1` lets prompt analysis also query the cloud classifier. Requires `ZN_API_KEY`. |
| `ZN_API_KEY` | unset | API key from [usezn.com/dashboard](https://usezn.com/dashboard/). No effect without `ZN_CLOUD=1`. |
| `ZN_LOCAL_ONLY` | unset | `true` forces local-only, even with `ZN_CLOUD=1`. |
| `ZN_STAGE` / `ZN_API_URL` | `v30` | Cloud endpoint selection. |

Custom rules: add banned patterns and forbidden paths in `.znrules` or `zn.config.json` at your project root ([example](packages/zn-gate/README.md#custom-rules-znrules-or-znconfigjson)).

Audit log: `zn-gate shield` appends each decision to `~/.zn/evidence.jsonl` as a hash-chained (SHA-256) record with a redacted preview. It detects accidental or partial edits; it is not tamper-proof against someone with write access to the file. Check it with `npx -y zn-gate evidence --verify`.

### GitHub Action

```yaml
- uses: usezn/zn@main
  with:
    version: '1.4.1'
    path: './prompts'
    fail-on-threat: 'true'
    format: 'github'
```

### Repository layout

- `packages/zn-gate`: Node.js CLI, MCP server and `shield` proxy (npm).
- `packages/zn-gate-py`: Python SDK and CLI (PyPI).
- `src/`: Rust gateway daemon.
- `bench/`: benchmark scripts and results.
- `assets/brand/`: logo files (SVG master and light/dark variants, PNG lockup and banners).

## FAQ

**Do I need an account or API key?** No. Everything local works without one.

**Does zn-gate slow my agent down?** The local check adds under a millisecond for typical prompts and tool outputs (p99 0.8 ms at 4 KB on our test host). See the measured table above.

**Will it block legitimate content?** Sometimes. Use `init --shadow` or `shield --shadow` to log detections without blocking while you evaluate it.

**Which agents are supported?** Any MCP client. `init` can rewrite configs for the agents listed under [Install](#install).

**How do I remove it?** `npx -y zn-gate init --revert` restores your configs from the backup. For a standalone server, remove the `zn-gate` entry from your agent config.

## Security

Report vulnerabilities to [security@usezn.com](mailto:security@usezn.com). Policy, scope and safe harbor: [SECURITY.md](SECURITY.md). Hall of Fame: [usezn.com/security](https://usezn.com/security/).

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. Copyright (c) 2026 usezn ([usezn.com](https://usezn.com)). The Galvanize-60M weights are Apache-2.0. The [zn-prompt-injection-bench](https://huggingface.co/datasets/usezn/zn-prompt-injection-bench) dataset is CC-BY-4.0.
