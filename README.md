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

**What it does:** keeps secret values out of what your agent sends to its model, checks what your agent reads and calls for prompt injection, and audits prompts, skills and configs. Everything runs on your machine, is MIT-licensed and needs no account. The Python package has no runtime dependencies; the npm package's only one is `age-encryption` (with its `@noble`/`@scure` dependencies) for the secret vault, bundled in the package.

## Install

Everything runs on your machine; no account or API key is needed. You need Node.js 18 or later (the LTS version from [nodejs.org](https://nodejs.org/)).

**Claude Code (recommended): the plugin.** You also need Git and Claude Code 2.1.295 or later.

```bash
claude plugin marketplace add usezn/zn
claude plugin install zn-gate@usezn
```

Already ran `zn hooks install claude-code` before? Run `zn hooks uninstall claude-code` first, otherwise both sets of hooks run.

Start a new Claude Code session. Claude Code is then blocked from reading `.env` files with real values and credential files, secrets in what its tools return are replaced with markers or redacted before the model sees them, a secret pasted into a prompt is blocked, and Claude can check untrusted text for prompt injection. Not covered: Claude Code sessions in the cloud, Cowork and chat. Details: [plugins/zn-gate](plugins/zn-gate/README.md).

**Codex CLI, Cursor or OpenCode: the hooks.**

```bash
npm install -g zn-gate
zn hooks install codex           # or: cursor, opencode
```

In Codex, approve the new hooks with `/hooks`. In Cursor, shell output and file contents are not scrubbed. What each agent supports: [docs/compat.md](docs/compat.md).

**Other editors** (VS Code, Antigravity, Windsurf, Cline, Zed, JetBrains, Continue): zn-gate works there as an MCP server only. Setup for each one: [usezn.com/docs/integrations/editors](https://usezn.com/docs/integrations/editors/).

**Then keep your `.env` values in the vault.** With the plugin or the hooks, the agent cannot read `.env` files with real values; move them into zn-gate's encrypted vault, and the file keeps markers such as `__ZN_STRIPE_KEY__`:

```bash
npx -y zn-gate unlock            # creates the vault the first time
npx -y zn-gate env shadow .env
```

After this, your own app also reads the markers in `.env`: start it with zn-gate's `run` command once you allow it ([docs/secrets.md](docs/secrets.md)). `env shadow` tells you how to undo it.

Five-minute walkthrough: [docs/secrets.md](docs/secrets.md). Limits: [docs/threat-model.md](docs/threat-model.md).

> **Windows PowerShell:** `npm` and `npx` can fail with "running scripts is disabled on this system", because the default execution policy blocks `npm.ps1`. Use `npm.cmd`, `npx.cmd` and `zn.cmd` instead (for example `npm.cmd install -g zn-gate`), run the commands from Command Prompt, or allow local scripts for your account with `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

**Python: for agents you build yourself** (rules engine and secret redaction for LangChain, CrewAI, LlamaIndex or plain tool calling). It does not protect Claude Code, Codex, Cursor or other coding agents. Install it in a virtual environment; many recent Linux systems, and Homebrew's Python on macOS, refuse `pip install` outside one ("externally-managed-environment"):

```bash
python3 -m venv .venv
.venv/bin/pip install zn-gate      # Windows: .venv\Scripts\pip install zn-gate
```

**zn-gate as an MCP server only** (the agent calls it when it decides to; not automatic protection):

```bash
claude mcp add zn-gate -- npx -y zn-gate mcp     # Claude Code
codex mcp add zn-gate -- npx -y zn-gate mcp      # Codex CLI
```

Cursor (`~/.cursor/mcp.json`) and other editors: `{ "mcpServers": { "zn-gate": { "command": "npx", "args": ["-y", "zn-gate", "mcp"] } } }`. OpenCode (`~/.config/opencode/opencode.json`): `{ "mcp": { "zn-gate": { "type": "local", "command": ["npx", "-y", "zn-gate", "mcp"], "enabled": true } } }`.

**Protect the MCP servers you already use.** `init` finds them in your agent configs, writes a backup, and wraps each local server with the zn-gate proxy:

```bash
npx -y zn-gate init --dry-run   # preview
npx -y zn-gate init             # wrap (backup first)
npx -y zn-gate init --revert    # undo
```

It reads Claude Desktop, Claude Code (`~/.claude.json`), Cursor (`~/.cursor/mcp.json`), Codex CLI (`~/.codex/config.toml`), OpenCode (`~/.config/opencode/opencode.json`) and Antigravity (`~/.gemini/antigravity/mcp_config.json`). [Full list and rules](packages/zn-gate/README.md#wrap-the-mcp-servers-you-already-use).

## Check that it works

```bash
npx -y zn-gate test
```

This runs the local self-test (51 curated vectors: 26 attacks, 25 benign) and shows per-decision latency on your machine. It is a smoke test, not a detection rate. Nothing is sent over the network.

**For developers: see the redaction by hand.** Send a tool output with a fake AWS key (AWS's documentation example) and a database password through zn-gate, exactly as your agent would, and look for `sanitized_content` in the output; that field is what the model would see:

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"check_tool_result","arguments":{"tool_name":"read_file","content":"AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\nDATABASE_URL=postgres://app:hunter2@db:5432/main"}}}' \
  | npx -y zn-gate@latest mcp
```

Python equivalent:

```bash
.venv/bin/python -c "from zn_gate import sanitize_tool_result as s; print(s('read_file', 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE')['sanitized_content'])"
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
- **Today, through zn-gate:** redacts AWS keys, OpenAI and Anthropic keys, GitHub tokens, JWTs, private keys and database URL passwords in everything that passes through zn-gate: tool output checked with `check_tool_result`, tool arguments checked with `check_tool_call`, and output of MCP servers wrapped by `zn-gate shield` / `init`. Python: `sanitize_tool_result`, `@guard(mask_secrets=True)` and the framework integrations.
- **Today, agent hooks and vault (npm package):** hooks for Claude Code, Codex CLI and OpenCode scrub the output of the agents' built-in tools and block pasted secrets (in Cursor only MCP tool output is scrubbed); a local encrypted vault with stable markers (`__ZN_AWS_KEY_1__`); `zn run` fills values only into commands you approved; personal data (cards, IBAN, national IDs, e-mail, phone) is detected too. What each agent allows differs: see [docs/compat.md](docs/compat.md).

### Galvanize: prompt-injection detection
- **Today, local:** a deterministic rules engine (signatures plus normalization against homoglyphs, zero-width characters, BiDi overrides, comment splicing and Base64) checks prompts, tool arguments, tool output and MCP tool descriptions.
- **Today, optional cloud check:** the Galvanize 2 classifier ([open weights on Hugging Face](https://huggingface.co/usezn/Galvanize-2), Apache-2.0) can also check prompts sent to `analyze_prompt`, only if you set `ZN_CLOUD=1` and `ZN_API_KEY`. The secrets zn-gate detects are removed from the prompt on your machine before it is sent; personal data is not removed on this path.
- **Roadmap:** running Galvanize locally inside zn-gate.

### Scan: audit what your agent is about to trust
- **Today:** `zn-gate scan <path>` audits prompt templates, `AGENTS.md` / `SKILL.md` files and configs for injection traps and leaked secrets (exit code 1 on findings, for CI). The same check runs as a [GitHub Action](#github-action). MCP servers can be checked on the web at [usezn.com/scan](https://usezn.com/scan).
- **Roadmap:** auditing MCP servers and skills from the CLI before you add them.

## What the cloud adds for teams

Everything above runs locally, for free, with no account. The optional cloud at [usezn.com](https://usezn.com) is for teams that need a shared record of what their agents did:

- **Audit and traceability:** an evidence dashboard with the metadata of each cloud decision (verdict, rule, score, latency), 90-day retention and CSV/JSONL export.
- **A larger detection model** for prompts, when you opt in (`ZN_CLOUD=1`).
- **Team controls** (shared policies, organization-level audit): in progress.

By default nothing is sent. If you set `ZN_CLOUD=1` and an API key, `analyze` sends the prompt text after removing the secrets zn-gate detects locally: personal data is not removed on this path, and a secret it does not detect would be sent with the text. The dashboard keeps the metadata of each cloud decision. Tool output and tool-call arguments are never sent.

## What leaves your machine

**Nothing, by default.**

```mermaid
flowchart LR
    subgraph local["Your machine"]
        A["Agent"]
        Z["zn-gate<br/>rules engine + secret redaction"]
        T["Tools and MCP servers<br/>files, shell, web, databases"]
    end
    C["api.usezn.com<br/>Galvanize 2 classifier"]
    A -- "tool calls and prompts" --> Z
    Z -- "allowed calls, secrets masked" --> T
    T -- "tool output" --> Z
    Z -- "redacted output, verdicts" --> A
    Z -. "prompts only, detected secrets removed,<br/>only with ZN_CLOUD=1 and ZN_API_KEY" .-> C
```

| Data | Evaluated | Sent anywhere? |
|---|---|---|
| Tool output (`check_tool_result`, `shield`) | Locally | **Never**, in any configuration |
| Tool-call arguments (`check_tool_call`, `shield`) | Locally | **Never**, in any configuration |
| MCP tool and parameter descriptions (`shield`) | Locally | **Never**, in any configuration |
| Counts of what zn-gate did (`zn-gate stats`: checks, blocks, secrets replaced, per secret type) | Written locally to `~/.zn/stats.json` | **Never**, unless you turn on `zn-gate stats share on`: then one report a day with a random installation id, the day, the zn-gate, OS and Node.js versions, the agent and part of zn-gate used most, and the number of secrets found per built-in type (never values, prompts, variable or secret names, paths, hosts or emails). `zn-gate stats share show` shows it first. |
| Prompts (`analyze_prompt`, `zn-gate analyze`, Python `analyze()`) | Locally | Only if you set **both** `ZN_CLOUD=1` and `ZN_API_KEY`. Detected secrets are removed locally before sending; personal data is not. |

`ZN_API_KEY` alone enables nothing. `ZN_LOCAL_ONLY=true` overrides `ZN_CLOUD=1`. `npx -y zn-gate status` prints what your configuration sends.

> **1.4.0 and earlier:** with `ZN_API_KEY` set, the Node package sent tool output and tool-call arguments to `api.usezn.com` without redaction. 1.4.1 removes that path. Details in the [CHANGELOG](CHANGELOG.md).

## Performance and accuracy

We only publish numbers we can reproduce, with the method next to them.

- **Latency of the local engine:** one table by input size, with hardware, date and the script to reproduce it (`bench/bench_by_size.js`), in the [npm package README](packages/zn-gate/README.md#performance-local-rules-engine-no-network). Short summary from that run: about 0.01 ms for a 200 B prompt, 0.3 ms for a 4 KB tool output with redaction, about 4 ms for 64 KB with redaction (p50).
- **Self-test:** 51 curated vectors pass. That is a smoke test, not a detection or false-positive rate.
- **Known limitation:** on whole source files, the rules can flag ordinary code comments. Version 1.5.0 reduces these on code and documentation, at the cost of letting some loosely worded override attempts through the local rules. To check it on your own source files, run `zn-gate scan --code <path>`; for the MCP servers you wrap, `--shadow` logs detections without blocking.
- **Known limitation:** detection of credentials under prefixed variable names (e.g. `OPENAI_API_KEY=`) is partial in this release.
- **Detection rates:** on a private held-out set of 3,309 examples, Galvanize 2 has 83.4% recall at a 0.81% false positive rate (serving threshold 0.662); these numbers are for the cloud classifier, not the local rules engine. Method, per-language results, known weak spots and a reproducible benchmark are in the [model card](https://huggingface.co/usezn/Galvanize-2) and the [announcement](https://usezn.com/blog/introducing-galvanize-2/). It is one layer of defense, not a guarantee.

## Configuration

| Variable | Default | Effect |
|---|---|---|
| `ZN_CLOUD` | off | `1` lets prompt analysis also query the cloud classifier. Requires `ZN_API_KEY`. |
| `ZN_API_KEY` | unset | API key from [usezn.com/dashboard](https://usezn.com/dashboard/). No effect without `ZN_CLOUD=1`. |
| `ZN_LOCAL_ONLY` | unset | `true` forces local-only, even with `ZN_CLOUD=1`. |
| `ZN_STAGE` / `ZN_API_URL` | `v30` | Cloud endpoint selection. |

zn Team: `zn team join <token>` connects a machine to your organization's signed secrets policy and uploads its audit log (metadata only). What the organization can and cannot change on the machine, offline behavior and the OpenTelemetry export (`zn vault log export --otlp`): [docs/team.md](docs/team.md).

Custom rules: add banned patterns and forbidden paths in `.znrules` or `zn.config.json` at your project root ([example](packages/zn-gate/README.md#custom-rules-znrules-or-znconfigjson)).

Audit log: `zn-gate shield` appends each decision to `~/.zn/evidence.jsonl` as a hash-chained (SHA-256) record with a redacted preview. It detects accidental or partial edits; it is not tamper-proof against someone with write access to the file. Check it with `npx -y zn-gate evidence --verify`.

### GitHub Action

The action installs the published `zn-gate` package from PyPI at an exact version and runs `zn-gate scan` on the path you give it. The scan runs entirely on the runner and sends nothing anywhere.

```yaml
name: AI agent security scan

on:
  pull_request:
    paths:
      - 'prompts/**'
      - '**/*.prompt'
      - '**/AGENTS.md'
      - '**/SKILL.md'

permissions:
  contents: read

jobs:
  zn-gate-scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0
        with:
          persist-credentials: false
      - name: Scan AI agent prompts and tools
        # Pin the action to a full commit SHA; the comment names the release.
        # v1.4.1 does not have the package-sha256 input (v1.5.0 and later).
        uses: usezn/zn@d9da1b1a87e12c4da468cb9beec425dc3f972c5f # v1.4.1
        with:
          version: '1.5.0'
          path: '.'
          fail-on-threat: 'true'
          format: 'github'
```

| Input | Default | Description |
|---|---|---|
| `version` | current stable release | Exact `zn-gate` version to install from PyPI. Ranges and `latest` are refused. |
| `package-sha256` | empty | Requires v1.5.0 or later of the action. SHA-256 of the wheel for `version`, as listed on PyPI. When set, the install fails if the downloaded file has a different hash. Older releases of the action ignore this input with only a warning, so no hash is checked. |
| `path` | `.` | File or directory to scan. |
| `fail-on-threat` | `true` | Fail the step when a threat is found. Set `false` to report only. |
| `format` | `github` | `github` (inline annotations), `text` or `json`. |

| Output | Description |
|---|---|
| `scan-exit-code` | Exit code of the scan: 0 clean (or `fail-on-threat: 'false'`), 1 threats found, 2 error. Empty if the scan did not run. |

The action needs only `contents: read`. It installs the wheel with `--only-binary=:all: --no-deps` (zn-gate has no dependencies) into a private virtualenv, so no build step runs and your job's own Python packages are not touched. pip still reads the runner's own pip settings (`PIP_*` environment variables and `pip.conf`), so a mirror or proxy you configure there is used; set `package-sha256` so that the wheel is checked whatever index it comes from. The action runs on `pull_request`, never on `pull_request_target`: do not check out untrusted pull-request code in a `pull_request_target` workflow.

### Repository layout

- `packages/zn-gate`: Node.js CLI, MCP server and `shield` proxy (npm).
- `packages/zn-gate-py`: Python SDK and CLI (PyPI).
- `src/`: legacy Rust gateway, not released ([docs/rust-core.md](docs/rust-core.md)).
- `bench/`: benchmark scripts and results.
- `assets/brand/`: logo files (SVG master and light/dark variants, PNG lockup and banners).

## FAQ

**Do I need an account or API key?** No. Everything local works without one. An account is only needed for the optional cloud (team audit and the larger detection model).

**Does zn-gate slow my agent down?** The local check adds under a millisecond for typical prompts and tool outputs (p99 0.8 ms at 4 KB on our test host). See the measured table above.

**Will it block legitimate content?** Sometimes. Use `init --shadow` or `shield --shadow` to log detections without blocking while you evaluate it.

**Which agents are supported?** Any MCP client. `init` can rewrite configs for the agents listed under [Install](#install).

**How do I remove it?** `npx -y zn-gate init --revert` restores your configs from the backup. For a standalone server, remove the `zn-gate` entry from your agent config.

## Security

Report vulnerabilities to [security@usezn.com](mailto:security@usezn.com). Policy, scope and safe harbor: [SECURITY.md](SECURITY.md). Hall of Fame: [usezn.com/security](https://usezn.com/security/).

Releases published by the release workflow, starting with the first one after 1.5.0-beta.1, are signed and carry build provenance. 1.5.0-beta.1 and earlier versions were published by hand and have no signatures or provenance. To check a download: [docs/verify-release.md](docs/verify-release.md).

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. Copyright (c) 2026 usezn ([usezn.com](https://usezn.com)). The [Galvanize 2](https://huggingface.co/usezn/Galvanize-2) and [Galvanize-60M](https://huggingface.co/usezn/Galvanize-60M) weights are Apache-2.0. The [zn-prompt-injection-bench](https://huggingface.co/datasets/usezn/zn-prompt-injection-bench) dataset is CC-BY-4.0. The npm package bundles third-party code listed in [THIRD_PARTY_NOTICES.md](packages/zn-gate/THIRD_PARTY_NOTICES.md).
