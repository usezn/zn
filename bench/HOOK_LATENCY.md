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

## Update 2026-10-19: lazy loading and the compile cache

Two changes to the hook process, with the same decisions and output as before:

- **Lazy loading.** Nothing left to move for the scrubber and the vault: a plain PreToolUse already did not
  load the scrubber engine, the vault client or the team policy (`lib/deps.js` loads them on first use),
  and a test now checks it. The one other candidate, loading `child_process` on first use, was measured and
  is not shipped: it gave no gain beyond the noise and it changes `lib/broker/files.js`, which is part of the
  policy layer (a change there needs a new rules version).
- **Compile cache.** On Node.js 22.1 and later, `lib/hooks/runner.js` calls `module.enableCompileCache()`
  before it loads the rest of the hook (`lib/compile-cache.js`). The cache is in `~/.zn/cache/compile`
  (`ZN_HOME` is respected). It holds code that every hook runs, so it is only used when the directories
  are real directories (not links), belong to the current user and are closed to others (mode 0700);
  otherwise the hook runs without it. `ZN_NO_COMPILE_CACHE=1` turns it off.

Method: `bench/hook_latency.js --runs 50`, vault unlocked (locked in the last row), run twice in a row,
each time for three variants in this order: `next` before the change, the lazy `child_process` change
alone (`ZN_NO_COMPILE_CACHE=1`) and that change with the cache (the cache is what ships). One ephemeral GCP VM (n2-standard-4, Xeon
2.8 GHz, Debian 12, Node 24.12, bare `node -e ""` 23 to 25 ms p50). The table is the mean of the two
rounds, p50 / p95 in ms. The first run after the cache directory is created (cold) is the warm-up run of
the benchmark and is not in the numbers.

| Case | Before | Lazy `child_process` only (not shipped) | Compile cache |
|---|---|---|---|
| PreToolUse Bash, no markers | 57.9 / 62.6 | 58.6 / 61.9 | **56.8 / 60.8** |
| UserPromptSubmit, 1 KB | 71.8 / 76.1 | 73.8 / 78.5 | **69.6 / 73.2** |
| PostToolUse Bash, 4 KB clean | 73.4 / 78.2 | 74.5 / 79.4 | **69.8 / 75.4** |
| PostToolUse Bash, 64 KB clean | 77.7 / 81.0 | 80.8 / 88.0 | **72.9 / 77.7** |
| PostToolUse Bash, 64 KB with 2 secrets | 85.6 / 92.5 | 89.4 / 94.3 | **82.9 / 87.7** |
| PostToolUse Bash, 64 KB with 2 secrets, vault locked | 78.1 / 82.7 | 80.0 / 84.2 | **72.0 / 78.2** |

Reading: the compile cache saves about 1 ms on PreToolUse and 3 to 6 ms on the events that load the
scrubber (4 to 8 % of the call). The lazy `child_process` change by itself is inside the noise of the VM (loading
the hook and the adapter drops from about 7.6 to 4.7 ms inside the process, but that does not show in the
wall-clock time of the whole process). The floor is still Node's own start-up; the 60 ms target for the
64 KB case is still not met on this machine, and the plan above (scanning inside the vault daemon) is
still the way to meet it.
