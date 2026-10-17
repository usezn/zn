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
  <strong>The local security layer for coding agents.</strong><br/>
  zn-gate guards your secrets, your data and your systems while you use Claude Code, Codex CLI, Cursor or OpenCode.<br/>
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

Everything runs on your machine; no account or API key is needed. You need Node.js 18 or later (the LTS version from [nodejs.org](https://nodejs.org/)). With an older Node.js, the `zn-gate` and `zn` commands stop and say how to install it. The Claude Code plugin needs Node.js 20.12 or later.

**Getting started: four steps, one command each.** Run them in your own terminal.

1. `npx -y zn-gate reach` shows what your coding agents can reach on this machine: secrets in your `.env` files (by name only), credential files and MCP servers. It is read only and sends nothing. Details in [docs/reach.md](docs/reach.md).
2. `npx -y zn-gate init` sets up protection for the coding agents it finds, one step at a time, and asks before each change.
3. `npx -y zn-gate check` tests that protection with a fake secret in a temporary folder. `init` runs it at the end too.
4. `npx -y zn-gate env shadow .env` moves the real values of your `.env` into the local vault and leaves markers in the file. The first time, run `npx -y zn-gate unlock` to create the vault.

**One command for the coding agents on your machine:**

```bash
npx -y zn-gate init
```

It finds Claude Code, Codex CLI, Cursor and OpenCode, shows the setup for each one that is not protected yet (the zn-gate plugin for Claude Code, zn's hooks for the others), runs each step after you confirm it, and ends with `zn-gate check`. Run it yourself in your own terminal, with no arguments: when an AI agent or a script runs it, it only prints the steps.

> **Windows PowerShell:** `npm` and `npx` can fail with "running scripts is disabled on this system", because the default execution policy blocks `npm.ps1`. Use `npm.cmd`, `npx.cmd` and `zn.cmd` instead (for example `npm.cmd install -g zn-gate`), run the commands from Command Prompt, or allow local scripts for your account with `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

**Then keep your `.env` values in the vault.** With the plugin or the hooks, the agent cannot read `.env` files with real values; move them into zn-gate's encrypted vault, and the file keeps markers such as `__ZN_STRIPE_KEY__`:

```bash
npx -y zn-gate unlock            # creates the vault the first time
npx -y zn-gate env shadow .env
```

After this, your own app also reads the markers in `.env`: start it with zn-gate's `run` command once you allow it ([docs/secrets.md](docs/secrets.md)). `env shadow` tells you how to undo it.

Five-minute walkthrough: [docs/secrets.md](docs/secrets.md). Limits: [docs/threat-model.md](docs/threat-model.md).

<details>
<summary><strong>Other ways to install</strong>: one agent at a time, other editors, Python, MCP server only, wrapping the MCP servers you already use</summary>

**One agent at a time** (the same steps `init` runs):

**Claude Code: the plugin.** You also need Git and Claude Code 2.1.295 or later.

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

**Python: for agents you build yourself** (rules engine and secret redaction for LangChain, CrewAI, LlamaIndex or plain tool calling). It does not protect Claude Code, Codex, Cursor or other coding agents. Install it in a virtual environment; many recent Linux systems, and Homebrew's Python on macOS, refuse `pip install` outside one ("externally-managed-environment"):

```bash
python3 -m venv .venv
.venv/bin/pip install zn-gate      # Windows: .venv\Scripts\pip install zn-gate
```

On Debian and Ubuntu, `python3 -m venv` needs the `python3-venv` package first: `sudo apt install python3-venv`.

**zn-gate as an MCP server only** (the agent calls it when it decides to; not automatic protection):

```bash
claude mcp add zn-gate -- npx -y zn-gate mcp     # Claude Code
codex mcp add zn-gate -- npx -y zn-gate mcp      # Codex CLI
```

Cursor (`~/.cursor/mcp.json`) and other editors: `{ "mcpServers": { "zn-gate": { "command": "npx", "args": ["-y", "zn-gate", "mcp"] } } }`. OpenCode (`~/.config/opencode/opencode.json`): `{ "mcp": { "zn-gate": { "type": "local", "command": ["npx", "-y", "zn-gate", "mcp"], "enabled": true } } }`.

**Protect the MCP servers you already use.** `init` finds them in your agent configs, writes a backup, and wraps each local server with the zn-gate proxy:

```bash
npx -y zn-gate init --dry-run   # preview
npx -y zn-gate init --wrap-mcp  # wrap (backup first)
npx -y zn-gate init --revert    # undo
```

It reads Claude Desktop, Claude Code (`~/.claude.json`), Cursor (`~/.cursor/mcp.json`), Codex CLI (`~/.codex/config.toml`), OpenCode (`~/.config/opencode/opencode.json`) and Antigravity (`~/.gemini/antigravity/mcp_config.json`). [Full list and rules](packages/zn-gate/README.md#wrap-the-mcp-servers-you-already-use).

</details>

## Check that it works

```bash
npx -y zn-gate check
```

For each agent set up for your user, zn-gate asks its hook to let the agent read a `.env` file with a fake key and an ordinary file, in a temporary folder. It shows what your agent would be told, and a line that says **NOT protected** says how to fix it. Nothing is sent over the network and no setting changes. [What the output means](docs/check.md).

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

<picture><source media="(prefers-color-scheme: dark)" srcset="docs/diagrams/tool-call-sequence-animated-dark.svg"><img alt="Sequence diagram. The agent sends analyze_prompt to zn-gate on your machine, which allows or blocks it. Then check_tool_call, which allows the call with secrets masked or blocks it. The agent runs the tool. The output comes back through check_tool_result or shield, and zn-gate returns it with secrets redacted, or neutralized if it carries an injection." src="docs/diagrams/tool-call-sequence-animated-light.svg" width="800"></picture>

### Scrubber: secrets stay out of the model's context
- **Today, through zn-gate:** redacts AWS keys, OpenAI and Anthropic keys, GitHub tokens, JWTs, private keys and database URL passwords in everything that passes through zn-gate: tool output checked with `check_tool_result`, tool arguments checked with `check_tool_call`, and output of MCP servers wrapped by `zn-gate shield` / `init`. Python: `sanitize_tool_result`, `@guard(mask_secrets=True)` and the framework integrations.
- **Today, agent hooks and vault (npm package):** hooks for Claude Code, Codex CLI and OpenCode scrub the output of the agents' built-in tools and block pasted secrets (in Cursor only MCP tool output is scrubbed); a local encrypted vault with stable markers (`__ZN_AWS_KEY_1__`); `zn run` fills values only into commands you approved; personal data (cards, IBAN, national IDs, e-mail, phone) is detected too. What each agent allows differs: see [docs/compat.md](docs/compat.md).

### Galvanize: prompt-injection detection
- **Today, local:** a deterministic rules engine (signatures plus normalization against homoglyphs, zero-width characters, BiDi overrides, comment splicing and Base64) checks prompts, tool arguments, tool output and MCP tool descriptions.
- **Today, optional cloud check:** the Galvanize 2 classifier ([open weights on Hugging Face](https://huggingface.co/usezn/Galvanize-2), Apache-2.0) can also check prompts sent to `analyze_prompt`, only if you set `ZN_CLOUD=1` and `ZN_API_KEY`. The secrets zn-gate detects are removed from the prompt on your machine before it is sent; personal data is not removed on this path.
- **Roadmap:** running Galvanize locally inside zn-gate.

### Scan: audit what your agent is about to trust
- **Today:** `zn-gate scan <path>` audits prompt templates, `AGENTS.md` / `SKILL.md` files and configs for injection traps and leaked secrets (exit code 1 on findings, for CI). A leaked secret is reported as **Secret found**, with the next step: `npx -y zn-gate env shadow <file>` moves the values of a `.env` file into the local vault, `npx -y zn-gate secret set NAME` stores any other one. It finds provider keys and tokens, opaque `Authorization: Bearer` tokens, passwords in URLs, and secrets passed as command-line flags (`--token=...`) or assigned to a name such as `password` or `api_key`. The same check runs as a [GitHub Action](#github-action). MCP servers can be checked on the web at [usezn.com/scan](https://usezn.com/scan).
- **Roadmap:** auditing MCP servers and skills from the CLI before you add them.

## What the cloud adds for teams

Everything above runs locally, for free, with no account. The optional cloud at [usezn.com](https://usezn.com) is for teams that need a shared record of what their agents did:

- **Audit and traceability:** an evidence dashboard with the metadata of each cloud decision (verdict, rule, score, latency), 90-day retention and CSV/JSONL export.
- **A larger detection model** for prompts, when you opt in (`ZN_CLOUD=1`).
- **Team controls** (shared policies, organization-level audit): in progress.

By default nothing is sent. If you set `ZN_CLOUD=1` and an API key (or the API key option of the Claude Code plugin), `analyze` sends the prompt text after removing the secrets zn-gate detects locally: personal data is not removed on this path, and a secret it does not detect would be sent with the text. The dashboard keeps the metadata of each cloud decision. Tool output and tool-call arguments are never sent.

## What leaves your machine

**Nothing, by default.**

<picture><source media="(prefers-color-scheme: dark)" srcset="docs/diagrams/data-flow-animated-dark.svg"><img alt="Flow diagram. The agent, zn-gate and the tools or MCP servers run on your machine, and tool calls and prompts go through zn-gate. Tool output comes back redacted. Nothing leaves the machine by default. Only with ZN_CLOUD=1 and ZN_API_KEY set (or the Claude Code plugin's API key option), prompts with detected secrets removed go to api.usezn.com, the Galvanize 2 classifier." src="docs/diagrams/data-flow-animated-light.svg" width="800"></picture>

| Data | Evaluated | Sent anywhere? |
|---|---|---|
| Tool output (`check_tool_result`, `shield`) | Locally | **Never**, in any configuration |
| Tool-call arguments (`check_tool_call`, `shield`) | Locally | **Never**, in any configuration |
| MCP tool and parameter descriptions (`shield`) | Locally | **Never**, in any configuration |
| Counts of what zn-gate did (`zn-gate stats`: checks, blocks, secrets replaced, per secret type) | Written locally to `~/.zn/stats.json` | **Never**, unless you turn on `zn-gate stats share on`: then one report a day with a random installation id, the day, the zn-gate, OS and Node.js versions, the agent and part of zn-gate used most, and the number of secrets found per built-in type (never values, prompts, variable or secret names, paths, hosts or emails). `zn-gate stats share show` shows it first. |
| Prompts (`analyze_prompt`, `zn-gate analyze`, Python `analyze()`) | Locally | Only if you set **both** `ZN_CLOUD=1` and `ZN_API_KEY`, or the API key option of the Claude Code plugin (for `analyze_prompt` only). Detected secrets are removed locally before sending; personal data is not. |

`ZN_API_KEY` alone enables nothing. `ZN_LOCAL_ONLY=true` overrides `ZN_CLOUD=1`. `npx -y zn-gate status` prints what your configuration sends.

> **1.4.0 and earlier:** with `ZN_API_KEY` set, the Node package sent tool output and tool-call arguments to `api.usezn.com` without redaction. 1.4.1 removes that path. Details in the [CHANGELOG](CHANGELOG.md).

## Performance and accuracy

We only publish numbers we can reproduce, with the method next to them.

- **Latency of the local engine:** one table by input size, with hardware, date and the script to reproduce it (`bench/bench_by_size.js`), in the [npm package README](packages/zn-gate/README.md#performance-local-rules-engine-no-network). Short summary from that run, with secret redaction (p50): about 0.045 ms for a 200 B prompt, 0.3 ms for a 4 KB tool output, about 4 ms for 64 KB.
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

The action installs the published zn-gate packages at an exact version and runs on the runner only; it sends nothing anywhere. It has two checks, chosen with `mode`:

- `scan` (default): `zn-gate scan` looks for prompt-injection traps and leaked secrets in prompts, tool definitions and config files (Python package from PyPI). This is what earlier releases of the action did.
- `audit`: `zn audit` reviews what your coding agents are configured to trust: `.claude/`, `.mcp.json`, `.codex/`, `.cursor/`, hooks, `AGENTS.md` / `CLAUDE.md`, plugins and skills (npm package; needs version 1.6.0 or later).
- `both`: runs the two. With a `version` older than 1.6.0, or a PyPI-only `.post` version, it runs the scan only and prints a warning.

Scan prompts on pull requests:

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
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - name: Scan AI agent prompts and tools
        # Pin the action to a full commit SHA; the comment names the release.
        uses: usezn/zn@98fc10e88c9c364b96fa65acc72a41386f0bd2e4 # v1.10.0
        with:
          version: '1.10.0'
          package-sha256: '36b3fbee7a846a4d8ba7b4c5e8b654d57b9a3fdbb9d99a2839f8cd83433b2d1d'
          path: '.'
          fail-on-threat: 'true'
          format: 'github'
```

Audit agent configs and plugins on every pull request, and show the findings in code scanning. The audit takes seconds, so the example has no `paths:` filter: a filter would skip the configs of agents it does not list.

```yaml
name: AI agent config audit

on:
  pull_request:

permissions:
  contents: read

jobs:
  zn-gate-audit:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      security-events: write   # only for the SARIF upload
      actions: read            # private repositories only, for upload-sarif
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - name: Audit agent configs
        id: zn
        # Pin to the full commit SHA of the first Action release that has the
        # mode input. The zn-gate package version is set by version below.
        uses: usezn/zn@<commit-sha> # <first Action release with mode>
        with:
          version: '1.10.0'
          mode: 'both'
          format: 'sarif'
          severity-threshold: 'medium'   # stricter than the default (high)
      - name: Upload SARIF
        if: ${{ !cancelled() && steps.zn.outputs.sarif-file != '' }}
        uses: github/codeql-action/upload-sarif@24c54180a607b1449ed407dd24f251e4e9147c8d # v4.38.3
        with:
          sarif_file: ${{ steps.zn.outputs.sarif-file }}
```

| Input | Default | Description |
|---|---|---|
| `version` | `1.10.0` | Exact `zn-gate` version to install. Ranges and `latest` are refused. `audit` needs 1.6.0 or later. |
| `mode` | `scan` | Requires a release of the action that includes audit mode (see the [CHANGELOG](CHANGELOG.md)). `scan`, `audit` or `both`. |
| `path` | `.` | File or directory to scan. `audit` needs a directory: with `both` a file skips the audit with a warning; with `audit` the step fails. |
| `fail-on-threat` | `true` | Fail the step on findings. For `scan`, anything found (an injection trap or a secret); for `audit`, findings at or above `severity-threshold`. Set `false` to report only. Any value other than `true` or `false` fails the step. `true` or `false`, in any case; other values fail the step. |
| `severity-threshold` | `high` | Requires a release of the action that includes audit mode (see the [CHANGELOG](CHANGELOG.md)). Audit only: lowest severity that fails the step when `fail-on-threat` is `true`: `critical`, `high` (high and critical), `medium` or `low`. The scan has no severities, so any scan finding fails. |
| `fail-on` | empty | Requires a release of the action that includes audit mode (see the [CHANGELOG](CHANGELOG.md)). Audit only: lowest severity that fails the step (`low`, `medium`, `high`, `critical`, `none`), passed as is to `zn audit --fail-on`. When set, it overrides `fail-on-threat` and `severity-threshold` for the audit. |
| `agents` | empty | Requires a release of the action that includes audit mode (see the [CHANGELOG](CHANGELOG.md)). Audit only: comma-separated agents to audit (`zn audit --agents`). Empty audits all supported agents. |
| `format` | `github` | `github` (inline annotations), `text`, `json` or `sarif` (`sarif` requires a release of the action that includes audit mode). |
| `sarif-file` | empty | Requires a release of the action that includes audit mode (see the [CHANGELOG](CHANGELOG.md)). With `format: sarif`, where to write the file: inside the workspace or the runner temp directory, and not a symbolic link or under one. Empty writes `zn-gate.sarif` in a new directory under the runner temp directory. |
| `package-sha256` | empty | Requires v1.5.0 or later of the action. SHA-256 of the PyPI wheel for `version`, as listed on PyPI. When set, the install fails if the downloaded file has a different hash. Older releases of the action ignore this input with only a warning, so no hash is checked. |
| `npm-integrity` | empty | Requires a release of the action that includes audit mode (see the [CHANGELOG](CHANGELOG.md)). Integrity string (`sha512-...`) of the npm tarball for `version`. When set, the audit fails if the tarball has a different hash. |

| Output | Description |
|---|---|
| `sarif-file` | Requires a release of the action that includes audit mode (see the [CHANGELOG](CHANGELOG.md)). Path of the SARIF file (`format: sarif` only). Empty if no check produced a report (for example, the scan ended in an error) or the file could not be written. |
| `scan-exit-code` | Exit code of the scan: 0 clean (or `fail-on-threat: 'false'`), 1 something found (an injection trap or a secret), 2 error. Empty if the scan did not run. |
| `audit-exit-code` | Requires a release of the action that includes audit mode (see the [CHANGELOG](CHANGELOG.md)). Exit code of the audit: 0 clean, 1 findings at or above `fail-on`, 2 error. Empty if it did not run. |

The scan finds more secret types with each release (1.9.1 added secrets passed as command-line flags and assigned to names such as `password` or `api_key`), so a job that fails on findings can start failing on files that passed before: pin `version` and read the findings before you update it.

Older releases of the action ignore the inputs they do not have, with only a warning: with one of them, `mode: audit` runs the scan instead.

Which audit findings fail the step: `fail-on` if it is set; otherwise none when `fail-on-threat` is `false`; otherwise `severity-threshold`. For the scan, only `fail-on-threat` applies.

With `mode: both` and `format: sarif`, the file holds one SARIF run per check (`zn-gate scan` and the audit's own run), each with its own category, so code scanning tracks their alerts separately. The step fails with the worse of the two results: an error beats findings.

Permissions: the action itself needs only `contents: read`; add `security-events: write` to the job only when you upload SARIF (and, in private repositories, `actions: read`, which `upload-sarif` needs). Packages are installed without running install scripts or build steps (`--only-binary=:all: --no-deps` for the wheel, `--ignore-scripts` for the npm tarball, whose dependencies are bundled) into private directories under the runner temp directory. pip still reads the runner's own pip settings (`PIP_*` environment variables and `pip.conf`), so a mirror or proxy you configure there is used; set `package-sha256` so that the wheel is checked whatever index it comes from (and `npm-integrity` for the npm tarball). Run it on `pull_request`, never on `pull_request_target`: do not check out untrusted pull-request code in a `pull_request_target` workflow. With `mode: audit` or `both` the action also sets up Node.js 22 for the rest of the job.

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

## Community and support

- **[Discussions](https://github.com/usezn/zn/discussions)**: questions about setup and use, ideas, and show and tell. Start here if you are not sure where your question belongs.
- **[Issues](https://github.com/usezn/zn/issues)**: reproducible bugs and concrete feature requests.
- **Security vulnerabilities**: do not post them in Discussions or Issues. Report them privately as described in [SECURITY.md](SECURITY.md).

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. Copyright (c) 2026 usezn ([usezn.com](https://usezn.com)). The [Galvanize 2](https://huggingface.co/usezn/Galvanize-2) and [Galvanize-60M](https://huggingface.co/usezn/Galvanize-60M) weights are Apache-2.0. The [zn-prompt-injection-bench](https://huggingface.co/datasets/usezn/zn-prompt-injection-bench) dataset is CC-BY-4.0. The npm package bundles third-party code listed in [THIRD_PARTY_NOTICES.md](packages/zn-gate/THIRD_PARTY_NOTICES.md).
