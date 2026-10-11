# Changelog

All notable changes to `zn-gate` (Node.js & Python SDKs) will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.4.1] - 2026-10-11

### Security
- **1.4.0: with `ZN_API_KEY` set, tool results and tool-call arguments were sent to api.usezn.com for analysis without redaction. 1.4.1 removes that path entirely; cloud analysis is now opt-in (`ZN_CLOUD=1`), prompt-only and redacted.**
  - Affected: the Node package (`zn-gate` on npm) up to and including 1.4.0, when `ZN_API_KEY` was set and `ZN_LOCAL_ONLY` was not `true`. Inputs blocked by the local rules were never sent. Without `ZN_API_KEY` nothing was sent.
  - Paths that sent data in 1.4.0: the MCP tools `check_tool_result`, `check_tool_call` and `analyze_prompt`, the `zn-gate shield` proxy (tool arguments, tool/parameter descriptions and tool results), `zn-gate analyze` and `zn-gate test`.
  - Python (`zn-gate` on PyPI) up to 1.4.0: only `analyze()` and `zn-gate analyze` sent data, when `ZN_API_KEY` was set, without redaction. `guard`, `check_tool_*`, `sanitize_tool_result` and the integrations were always local.
  - Recommended action: upgrade to 1.4.1. If you used 1.4.0 with `ZN_API_KEY`, consider rotating any credential that could have appeared in tool output.

### Changed
- **Tool results, tool-call arguments and tool descriptions are evaluated only locally**, under every configuration (MCP server, `shield`, library API).
- **Cloud analysis is opt-in:** it requires both `ZN_API_KEY` and `ZN_CLOUD=1`, applies only to prompt analysis (`analyze_prompt`, `zn-gate analyze`, `analyze()`), and the text is passed through `redactSecrets` / `redact_secrets` before sending. `ZN_LOCAL_ONLY=true` still overrides everything.
- **Secret redaction now runs on the real code path:** `check_tool_result` always returns content passed through `sanitizeToolResult`; `check_tool_call` returns `sanitized_arguments`; `shield` forwards allowed tool output with secrets redacted (not in `--shadow` mode). In 1.4.0 these functions existed but no executable path called them.
- The local audit log stores a secret-redacted `payload_preview` (the SHA-256 is still computed over the original payload).
- `zn_status` and `zn-gate status` report what leaves the machine. Removed the "Set ZN_API_KEY for neural protection" tip.
- `zn-gate test` (self-test) never uses the network.

### Fixed
- Python CLI: `zn-gate test` printed `BLOCK` when the verdict was `allow` and only the secret detector had fired. It now prints the real verdict and the DLP alert on its own line. The exit code is unchanged: 1 whenever something was flagged (a block or a secret).
- `zn-gate init` config locations and formats, verified against the official docs:
  - **Codex CLI:** `~/.codex/config.toml` (or `$CODEX_HOME/config.toml`), `[mcp_servers.<name>]` TOML tables. 1.4.0 wrote to a non-existent `~/.codex/config.json`.
  - **OpenCode:** `~/.config/opencode/opencode.json` (`mcp` key, `command` array, `type: "local"`). 1.4.0 used `~/.local/share/opencode/mcp.json`.
  - **Claude Desktop on Linux:** `~/.config/Claude/` (1.4.0 used `~/config/Claude/`, missing the dot).
  - Files that cannot be rewritten safely (JSONC with comments, multi-line TOML arrays) are reported as "wrap manually" instead of being modified.

### Documentation
- Removed figures without a public method (fixed "< 0.1 ms" style latency claims, "99.4 % accuracy", the comparison table against other guardrails, "100 % defense rate"). Added a single latency table with hardware, date and `bench/bench_by_size.js` to reproduce it.
- "Cryptographic / tamper-evident ledger" reworded: it is a hash-chained local log that detects accidental edits, not tamper-proof against someone with write access.
- Added "What leaves your machine" to all READMEs.
- Rewrote the GitHub, npm and PyPI READMEs around one path: what it is, one-command install per agent, a reproducible redaction check, what Scrubber / Galvanize / Scan do today (roadmap marked separately), data flow, measured numbers only, configuration, FAQ, security. Badges limited to CI, version and license.
- Documented a known limitation: false positives on whole source files in `check_tool_result` (not fixed in this release).

---

## [1.4.0] - 2026-09-29

### Added
- **Static Workspace & Prompt Security Scanner (`zn-gate scan <path>`)**:
  - Recursively audits prompt templates, markdown guides (`AGENTS.md`, `SKILL.md`), and configuration files for injection traps, covert beacons, and secret leaks.
  - Zero-configuration exit codes (`0` clean, `1` threats found) for seamless integration with git pre-commit hooks and CI/CD pipelines.
- **Trojan Source & BiDi Override Defense (CVE-2021-42574)**:
  - Detects and neutralizes Unicode Bidirectional override characters (`\u202A-\u202E`, `\u2066-\u2069`) across Node.js and Python engines.
- **Hidden CSS Injection Defense**:
  - Intercepts and neutralizes third-party tool outputs containing invisible CSS text (`display: none`, `opacity: 0`, `font-size: 0px`, `color: transparent`, `text-indent: -9999px`).
- **Multilingual Prompt Injection (German)**:
  - Added native detection rules for German prompt injection attempts (`pi:multi_de`) across Node.js and Python.
- **Expanded Self-Test Suite (51 Vectors)**:
  - Evaluates 26 attack patterns and 25 diverse benign developer scenarios (React, Next.js, TypeScript, Python, Rust, Docker, SQL, GraphQL, AWS CLI) with 100% accuracy and 0 false positives.

### Changed
- Migrated primary repository to official organization: **https://github.com/usezn/zn**.
- Synchronized rules engine to `RULES_VERSION: 2026-09-29.1`.

---

## [1.3.0] - 2026-09-06

### Added
- **1-Click MCP Auto-Shielding (`zn-gate init`)**:
  - Auto-discovers and wraps active MCP configurations across 7 leading AI agent environments: **Claude Desktop**, **Claude Code**, **Cursor**, **Antigravity**, **Codex**, **OpenCode**, and **Goose / Cline**.
  - Safe in-place configuration patching with automatic backup creation (`config.json.zn-backup-<timestamp>`).
  - Supports `--dry-run` for risk-free auditing, `--shadow` for non-blocking observation, and `--revert` for instant 1-command rollback.
- **Universal MCP Security Proxy (`zn-gate shield`)**:
  - Lightweight stdio proxy that wraps any external MCP executable (`uvx`, `npx`, `node`, `python`).
  - Intercepts JSON-RPC 2.0 messages bidirectionally: blocks malicious arguments pre-execution and sanitizes poisoned tool results post-execution.
- **MCP Tool Poisoning & Description Defense**:
  - Automatically intercepts `tools/list` responses from external servers.
  - Deep-scans tool descriptions and parameter schemas (`inputSchema.properties`) for adversarial instructions before LLM context ingestion.
  - Neutralizes poisoned descriptions while preserving legitimate tool availability.
- **Cryptographic Evidence Engine**:
  - Tamper-evident SHA-256 hash-chained audit ledger (`~/.zn/evidence.jsonl`) recording every verdict, tool name, payload hash, and decision latency.
  - **100% Cross-Language Interoperability**: Identical canonical JSON serialization guarantees byte-for-byte SHA-256 chain verification across Node.js and Python.
  - Built-in verification via `zn-gate evidence --verify` and `verify_evidence_ledger()`.
- **Compliance Audit Exporter (SOC 2 / ISO 27001 / EU AI Act Art. 12)**:
  - Export audit ledgers into JSONL and CSV formats with genesis-to-tip integrity verification via CLI (`zn-gate evidence --export [--format=jsonl|csv] [--output=file]`).
  - Interactive local dashboard (`zn-gate evidence --ui`) with real-time stats and HTTP download endpoints (`/api/export?format=jsonl|csv`).
  - Full Python parity via `zn_gate.export_evidence_ledger()`.

---

## [1.2.4] - 2026-09-06

### Added
- **Hybrid Inspection Mode**:
  - Direct prompt injections and sensitive secret leaks are evaluated in-process in **< 10 µs at $0 cost**.
  - Obvious attacks short-circuit immediately with `mode: 'hybrid-local-fastpath'`, eliminating 100% of network round-trips and API egress costs.
  - When `ZN_API_KEY` is provided, clean inputs and tool results seamlessly escalate to the **zn Cloud Gate (v30)** for deep multilingual neural classification.
- **Python SDK Client**:
  - Pure stdlib client module (`zn_gate.analyze()`, `zn_gate.analyze_cloud()`, `zn_gate.resolve_endpoint()`) with **zero external dependencies**.
- **Agent Framework Integrations**:
  - Full support and test matrices for **LangChain** (`ZnGuardCallbackHandler`), **CrewAI** (`@guarded_tool`), **LlamaIndex** (`ZnLlamaGuard`), and **Promptfoo** custom evaluation provider.
- **Continuous Integration (CI)**:
  - Multi-platform GitHub Actions workflow (`.github/workflows/ci.yml`) covering Node 18, 20, 22 and Python 3.9 through 3.13.

### Optimized
- **LRU-2048 Cache Architecture**:
  - Implemented version- and config-guarded LRU cache for `evaluate()` in both Node.js and Python.
  - Latency on cached hits drops to **< 18 µs p99** (Node p50: 4.9 µs, Python p50: 0.9 µs).
  - High-throughput un-cached execution exceeds **114,000 req/s** (Node) and **17,000 req/s** (Python).

### Fixed & Hardened (Security)
- **znRed v2 Adversarial Fuzzing Hardening**:
  - Hardened `pi:ignore_previous`, `pi:disregard`, and `pi:override` against 1,500 fuzzer mutations.
  - Achieved **97.93% overall block rate** on evasion vectors (100% on zero-width, markdown wrapping, casing/spacing, and semantic framing).
- **False Positive Elimination on Developer Tool Outputs**:
  - Refined `pi:override` to target explicit attack objects (`system|policy|safety|rules|instructions|guidelines|restrictions`).
  - Achieved **0.00% False Positive Rate** across 400 real-world benign tool outputs (SQL, JSON, HTTP payloads, and technical documentation).

---

## [1.2.3] - 2026-09-05
- Automatic DLP credential masking (`redactSecrets` / `redact_secrets`).
- Enhanced AST pre-normalization for Cyrillic homoglyphs and invisible unicode characters.
- Initial release of Python SDK (`zn-gate` on PyPI).

## [1.2.0] - 2026-08-26
- MCP Server interface for Claude Code, Cursor, and custom agent loops.
- Bidirectional inspection for prompt inputs and tool returns.
