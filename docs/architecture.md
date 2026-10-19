# zn Architecture

zn operates as a **sacrificial, lightweight checkpoint** situated directly between AI agents (or LLMs) and untrusted external inputs.

![zn Architecture](../assets/architecture.svg)

## Defense-in-Depth Lifecycle

zn enforces security across three distinct lifecycle phases:

```text
[User / External Input]
         │
         ▼
 ┌───────────────┐
 │ analyze_prompt│ ──► Pre-execution check (Jailbreaks, roleplay, LFI, exfil)
 └───────┬───────┘
         │ (Clean)
         ▼
    [AI Agent]
         │
         ▼
 ┌─────────────────┐
 │ check_tool_call │ ──► Pre-flight tool argument check (bash, DB queries, file ops)
 └───────┬─────────┘
         │ (Safe)
         ▼
  [Tool Execution] (Web search, bash, filesystem, APIs)
         │
         ▼
 ┌──────────────────┐
 │check_tool_result │ ──► Post-execution result check (Indirect injection, DLP redaction)
 └───────┬──────────┘
         │ (Sanitized)
         ▼
    [LLM Context]
```

## Key Architectural Principles

1. **Minimal Dependencies:**
   `zn-gate-py` (PyPI) uses the Python standard library only. `zn-gate` (npm) has no runtime dependencies except `age-encryption` (and its `@noble`/`@scure` dependencies) for the secret vault, bundled in the npm package at the versions pinned in `package-lock.json`. No native compilation.

2. **Deterministic Local Fast Path:**
   Local evaluation uses compiled regular expressions, homoglyph normalization, and a 2048-entry LRU cache. Measured latencies by input size, with hardware and the script to reproduce them, are in the [npm package README](../packages/zn-gate/README.md#performance-local-rules-engine-no-network).

3. **Optional Cloud Second Opinion (opt-in):**
   Only prompt analysis (`analyze()`) can query the cloud classifier, and only when both `ZN_API_KEY` and `ZN_CLOUD=1` are set, or the user ran `zn-gate connect` (`ZN_LOCAL_ONLY=true` overrides it). Attacks caught by the local rules are blocked in-process first, and the text is secret-redacted locally before it is sent. Tool arguments, tool output and tool descriptions never leave the machine.

4. **Hash-Chained Local Audit Log:**
   Each recorded assessment is hashed with SHA-256 and chained into `~/.zn/evidence.jsonl`, with canonical JSON in both the Node and Python implementations. The chain detects accidental or partial edits; it is not tamper-proof against someone with write access to the file, who can recompute it.
