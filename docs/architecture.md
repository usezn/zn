# zn Architecture

zn-gate is a **lightweight checkpoint on your machine**, placed between your AI coding agent and everything it does not control: your prompts, the files it reads, web pages, and the tools and MCP servers it calls. It runs locally, needs no account, and sends nothing off the machine by default.

<picture><source media="(prefers-color-scheme: dark)" srcset="diagrams/architecture-animated-dark.svg"><img alt="Architecture diagram. Untrusted input such as prompts, files, web pages and MCP servers passes through zn-gate on your machine before it reaches the agent. zn-gate checks the prompt, the tool call and the tool result, using a local rules engine, a PII and secret scrubber, an encrypted vault and a hash-chained decision log. Only with ZN_CLOUD=1 and ZN_API_KEY set, prompts with detected secrets removed go to the optional Galvanize 3 classifier at api.usezn.com." src="diagrams/architecture-animated-light.svg" width="800"></picture>

**How to read this diagram**

- The boxes: untrusted input (prompts, files, web, MCP) on the left, the agent and its tools on the right, and zn-gate between them with one box per check (`analyze_prompt`, `check_tool_call`, `check_tool_result`).
- The arrows: input goes through the three checks and reaches the agent as clean input, and output comes back redacted. The bottom row (rules engine, PII and secret scrubber, encrypted vault, hash-chained audit log) is used by all three checks.
- The cloud path: only with `ZN_CLOUD=1` and `ZN_API_KEY` set, prompts with detected secrets removed go to the Galvanize 3 classifier at `api.usezn.com`.

## Three checks, one local engine

zn-gate checks each step of a tool call. The same local pieces serve all three checks:

| Check | When it runs | What it looks for |
|---|---|---|
| `analyze_prompt` | Before the agent acts on a prompt | Prompt injection, jailbreaks and role-play tricks, file-read and exfiltration requests |
| `check_tool_call` | Before a tool runs | Prompt-injection wording, requests for secrets and secret-file names in the arguments, and secrets in arguments (masked). It is a text check: it does not judge whether a shell command or a query is destructive |
| `check_tool_result` | After a tool runs, before the model sees the output | Indirect injection hidden in the output, secrets and personal data (redacted) |

The local pieces:

- **Rules engine.** Signatures plus normalization against homoglyphs, zero-width characters, BiDi overrides and comment splicing; shell commands that decode Base64 text and run it are recognised, but a Base64 string on its own is not decoded. It checks prompts, tool arguments, tool output and MCP tool descriptions.
- **PII and secret scrubber.** Replaces the secrets it recognises (provider keys, tokens, JWTs, private keys, database URL passwords) and detects personal data (cards, IBAN, national IDs, e-mail, phone). The model sees a marker or `[REDACTED_...]` text instead of the value.
- **Encrypted vault.** Keeps the real values of your secrets on your machine. The agent works with stable markers such as `__ZN_AWS_KEY_1__`, and `zn run` puts a value in the environment of a command only when you approved it.
- **Hash-chained decision log.** Records each assessment in `~/.zn/evidence.jsonl`.

## One tool call, step by step

Here is one tool call from the agent to the answer, using only what is described on this page:

1. The agent gets a prompt. `analyze_prompt` checks it first for prompt injection, jailbreaks and requests to read files or exfiltrate data.
2. The agent decides to call a tool, for example one on an MCP server.
3. Before the tool runs, `check_tool_call` reads the arguments as text. It looks for injection wording, requests for secrets, secret-file names and secrets, which it masks.
4. If the arguments pass, the tool runs. If you approved a command, `zn run` fills in the real value of a secret marker such as `__ZN_AWS_KEY_1__` at that point. The agent itself only works with the marker.
5. After the tool runs and before the model sees the output, `check_tool_result` looks for indirect injection hidden in it. Secrets and personal data are redacted.
6. The model sees the cleaned output, with a marker or `[REDACTED_...]` text in place of any removed value, and gives its answer.
7. Each assessment is recorded in the hash-chained audit log at `~/.zn/evidence.jsonl`.

All of these checks use the local engine. Tool arguments never leave the machine, and neither does tool output, except in one opt-in case: with the cloud check on, the Claude Code hook sends a capped sample of web, MCP and shell results with secrets and personal data (email addresses, phone numbers, IBANs and card numbers) removed to the cloud classifier. See [Key Architectural Principles](#key-architectural-principles) for the details.

## How it attaches to your agent

- **Local hooks.** For Claude Code, Codex CLI, Cursor, OpenCode, Antigravity, ZCode desktop app and GitHub Copilot (and, as an experimental adapter, Gemini CLI), `zn hooks install <agent>` registers zn-gate's hooks, so it also sees the agent's built-in tools: it blocks reads of secret files and pasted secrets, and scrubs shell output and file contents. (In Cursor, only MCP tool output is scrubbed; in Antigravity and ZCode desktop app, no tool output is rewritten.) What each agent allows is in [Agent compatibility](compat.md).
- **MCP server and `shield`.** In editors that only support MCP servers, zn-gate offers its checks as MCP tools (`analyze_prompt`, `check_tool_call`, `check_tool_result`) and can wrap your other MCP servers with `zn-gate shield`. See [Editors and coding agents](editors/README.md).
- **Library.** Node.js and Python functions, and framework integrations, run the same checks inside your own code ([API reference](api-reference.md)).

## Two more views of the same flow

Where each check sits in a tool call, as an MCP server or as the `shield` proxy around other servers:

<picture><source media="(prefers-color-scheme: dark)" srcset="diagrams/tool-call-sequence-animated-dark.svg"><img alt="Sequence diagram. The agent sends analyze_prompt to zn-gate on your machine, which allows or blocks it. Then check_tool_call, which allows the call with secrets masked or blocks it. The agent runs the tool. The output comes back through check_tool_result or shield, and zn-gate returns it with secrets redacted, or neutralized if it carries an injection." src="diagrams/tool-call-sequence-animated-light.svg" width="800"></picture>

**How to read this diagram**

- The boxes: the agent, zn-gate (on your machine) and the tool or MCP server. Time runs from top to bottom.
- The arrows going to zn-gate: `analyze_prompt` is answered with allow, or block with the rule that fired; `check_tool_call` (name, arguments) is answered with allow with secrets masked, or block.
- The arrows after the tool runs: the output comes back through `check_tool_result` (or through `shield`) and reaches the agent with secrets redacted, or neutralized if it carries an injection.

What goes where on your machine, and what can leave it:

<picture><source media="(prefers-color-scheme: dark)" srcset="diagrams/data-flow-animated-dark.svg"><img alt="Flow diagram. The agent, zn-gate and the tools or MCP servers run on your machine, and tool calls and prompts go through zn-gate. Tool output comes back redacted. Nothing leaves the machine by default. Only with ZN_CLOUD=1 and ZN_API_KEY set (or the Claude Code plugin's API key option), prompts with detected secrets removed go to api.usezn.com, the Galvanize 3 classifier." src="diagrams/data-flow-animated-light.svg" width="800"></picture>

**How to read this diagram**

- The boxes: the agent, zn-gate (rules engine and secret redaction) and the tools and MCP servers (files, shell, web, databases), all inside "Your machine".
- The arrows: tool calls and prompts go to zn-gate, allowed calls reach the tools with secrets masked, and tool output comes back through zn-gate as redacted output and verdicts.
- The cloud arrow: nothing leaves the machine by default. Only with `ZN_CLOUD=1` and `ZN_API_KEY` set, prompts with detected secrets removed go to the Galvanize 3 classifier at `api.usezn.com`.

## Key Architectural Principles

1. **Minimal Dependencies:**
   `zn-gate-py` (PyPI) uses the Python standard library only. `zn-gate` (npm) has no runtime dependencies except `age-encryption` (and its `@noble`/`@scure` dependencies) for the secret vault, bundled in the npm package at the versions pinned in `package-lock.json`. No native compilation.

2. **Deterministic Local Fast Path:**
   Local evaluation uses compiled regular expressions, homoglyph normalization, and a 2048-entry LRU cache. Measured latencies by input size, with hardware and the script to reproduce them, are in the [npm package README](../packages/zn-gate/README.md#performance-local-rules-engine-no-network).

3. **Optional Cloud Second Opinion (opt-in):**
   Two things can query the cloud classifier: prompt analysis (`analyze()`), and, when the cloud check is on, the Claude Code hook for tool output (see below). Prompt analysis runs when `ZN_API_KEY` and `ZN_CLOUD=1` are set, or the user ran `zn-gate connect`; the tool-output hook runs only after `zn-gate connect`, because a project can set environment variables for the agent (`ZN_LOCAL_ONLY=true` overrides both). Attacks caught by the local rules are blocked in-process first, and the text is secret-redacted locally before it is sent (personal data, and a secret zn-gate does not recognize, is not removed). If the cloud call fails, the local result stands (`fallback: true`) and nothing is blocked because of it. Tool arguments and tool descriptions never leave the machine. Tool output stays local too, except that the Claude Code hook, when the user ran `zn-gate connect`, also sends a sample of at most 16 KiB, counted in bytes of UTF-8 text (the first 12 KiB and the last 4 KiB), of each web, MCP or shell result after the same secret redaction and with email addresses, phone numbers, IBANs and card numbers replaced, and a failed call changes nothing (`hooks.cloudCheckToolOutput: false` turns that off).

4. **Hash-Chained Local Decision Log:**
   Each recorded assessment is hashed with SHA-256 and chained into `~/.zn/evidence.jsonl`, with canonical JSON in both the Node and Python implementations. The chain detects accidental or partial edits; it is not tamper-proof against someone with write access to the file, who can recompute it.

See also: [What leaves your machine](../README.md#what-leaves-your-machine), the [threat model](threat-model.md) and the [glossary](glossary.md).

## Read next

- [Check that it works](check.md): run `zn-gate check` to confirm zn-gate is protecting your agent.
- [zn-gate reach](reach.md): see on one screen what your coding agents can reach.
- [See what zn-gate did this week](report.md): read the weekly `zn-gate report`.
- [Remove zn-gate](uninstall.md): uninstall in one step or piece by piece.
