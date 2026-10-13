# Hook process latency

What an agent waits for on each tool call: one `node lib/hooks/runner.js claude-code`
process, started with the event on stdin, until it exits. Measured with the real
scrubber engine and a real vault daemon (`bench/hook_latency.js`, 30 runs per case
after one warm-up run, fake values generated at run time).

Reproduce:

```bash
node bench/hook_latency.js --runs 30 --json hook_latency.json
```

## Results (2026-10-11)

Target for 1.5.0: PostToolUse with 64 KB of output, p50 <= 60 ms.
**Not met on either machine.** The floor is Node's own start-up time, which
already takes 42 to 50 ms before any zn code runs.

| Case (vault unlocked) | Desktop: Windows 11, Ryzen 7 9700X, Node 24.12 (p50 / p95 ms) | Server: Ubuntu, Xeon 8259CL x2, Node 24.21 (p50 / p95 ms) |
|---|---|---|
| bare `node -e ""` | 41.6 | 50.1 |
| PreToolUse Bash, no markers | 62.2 / 74.4 | 86.9 / 102.2 |
| UserPromptSubmit, 1 KB | 77.2 / 96.3 | 106.6 / 145.3 |
| PostToolUse Bash, 4 KB clean | 76.9 / 95.6 | 106.8 / 125.7 |
| PostToolUse Bash, 64 KB clean | 78.5 / 81.3 | 116.4 / 133.7 |
| PostToolUse Bash, 64 KB with 2 secrets | **77.9** / 100.3 | **124.4** / 136.0 |

With the vault locked (irreversible redaction) the numbers are the same
within noise (64 KB with secrets: 90.1 ms desktop, 112.4 ms server).

## Where the time goes (desktop, one PostToolUse 64 KB)

| Step | ms |
|---|---|
| Node start-up | ~42 |
| Loading the hook, the adapter, the engine and the vault client | ~18 |
| Connecting to the daemon (mutual HMAC handshake) | ~4 |
| Exact values from the vault + scanning 64 KB (first run in the process, including regex compilation) | ~8 |

The engine alone scans 64 KB in about 2 to 3 ms when warm (`bench/SCRUB_LATENCY.md`);
in a fresh process the first scan also compiles about 50 regular expressions.
Node's compile cache (`NODE_COMPILE_CACHE`) made no measurable difference.

## What would meet the target

Remove per-call work from the hook process: the vault daemon is already a
long-lived process, so it could run `tokenize` itself and the hook would only
forward the event over the socket (estimated 15 to 20 ms over Node start-up on
the desktop). That moves the scanner into the process that holds the vault, so
it needs its own review. It is not part of 1.5.0, which ships with the
numbers above.

## Decision for 1.5.0

Version 1.5.0 accepts the measured cost: about **78 ms p50 per hook call** on the
Windows desktop (PostToolUse, 64 KB with secrets) and about 124 ms on the
server. The floor is Node's own start-up (42 to 50 ms), so the 60 ms target
can only be met by moving the scan out of the hook process and into the vault
daemon. That puts the scanner next to the vault keys, so it gets its own
security review after 1.5.0.
