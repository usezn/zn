# Performance of the agent hooks

Each time a coding agent calls a tool, it starts zn's hook and waits for it: once before the call (for
example a shell command) and once after it, with the tool's output. This page says how long that takes and
how it is measured.

## How it is measured

`bench/hook_latency_matrix.js` starts `node lib/hooks/runner.js <agent>` with the agent's event on stdin,
exactly as the agent does, and times it until the process exits:

- Claude Code and Codex CLI: `PreToolUse` for a shell command, and `PostToolUse` with shell output.
- Cursor: `beforeShellExecution`, and `postToolUse` with MCP output (Cursor only lets zn rewrite MCP
  output; see [compat.md](compat.md)).
- Outputs of 1 KB, 100 KB (also with two secrets in it) and 1000 KB of source-like text.
- The vault is locked, so detected values are redacted for good and no background process is involved.
- Each case runs 40 times after one warm-up run; p95 is the 38th of the 40 times (nearest rank).
- Fake values are generated for the run. A case fails if one of them comes back from the hook, if the hook
  could not check the output, or if a case with secrets has no zn marker in place of them.

```bash
cd packages/zn-gate && npm ci --ignore-scripts && cd ../..
node bench/hook_latency_matrix.js --runs 40
```

Most of the time is Node.js starting: a bare `node -e ""` is measured between the samples of every case,
and each result is also given as its p95 divided by that start-up time.

## Results

GitHub Actions `ubuntu-latest` runner (4 vCPU AMD EPYC 7763), Node.js 22.23, 2026-10-19, with the compile
cache of the hook enabled. Times in milliseconds; a bare `node -e ""` takes 24 ms (p50). Runner speed varies
from one run to the next by a few milliseconds; the budget below compares against Node's start-up in the same run.

| Agent | Event | p50 | p95 |
|---|---|---|---|
| Claude Code | PreToolUse, shell command | 54 | 56.1 |
| Codex CLI | PreToolUse, shell command | 53.1 | 55.6 |
| Cursor | beforeShellExecution | 53.7 | 55.4 |
| Claude Code | PostToolUse, 1 KB | 57.3 | 61.6 |
| Codex CLI | PostToolUse, 1 KB | 57.2 | 60.7 |
| Cursor | postToolUse (MCP), 1 KB | 57.1 | 58.8 |
| Claude Code | PostToolUse, 100 KB | 61.9 | 65.4 |
| Codex CLI | PostToolUse, 100 KB | 62 | 63.7 |
| Cursor | postToolUse (MCP), 100 KB | 62.3 | 64.2 |
| Claude Code | PostToolUse, 100 KB with 2 secrets | 69.5 | 72.3 |
| Codex CLI | PostToolUse, 100 KB with 2 secrets | 68.8 | 72.3 |
| Cursor | postToolUse (MCP), 100 KB with 2 secrets | 69.1 | 71.4 |
| Claude Code | PostToolUse, 1000 KB | 79.7 | 81.4 |
| Codex CLI | PostToolUse, 1000 KB | 79.2 | 82.6 |
| Cursor | postToolUse (MCP), 1000 KB | 82.5 | 86.7 |

On another machine the times change with it: dividing by Node's own start-up, as the budget does, removes
most of that difference, not all of it.
[`bench/HOOK_LATENCY.md`](../bench/HOOK_LATENCY.md) has earlier measurements with the vault unlocked and a
breakdown of where the time goes.

OpenCode is not in the table: its zn plugin runs inside the OpenCode process, so no hook process is started.

## How to read these numbers

- **Agent** is the coding agent that starts the hook: Claude Code, Codex CLI or Cursor.
- **Event** is the moment the hook runs. `PreToolUse` and `beforeShellExecution` run before a shell command;
  `PostToolUse` and `postToolUse` run after a tool, with its output. A size such as 1 KB, 100 KB or
  1000 KB is the size of that output, and "with 2 secrets" means two fake secrets are in it.
- **p50** is the median: half of the 40 runs of the case were faster than this, half were slower. It is the
  usual wait.
- **p95** is the 38th of the 40 sorted times, so only 2 runs were slower. It is the wait on a slow run.
- All times are in milliseconds (ms); 1000 ms is one second.

For example, a p50 of 54 and a p95 of 56.1 mean the hook usually takes about 54 ms, and nearly always under
57 ms. Compare a row with the 24 ms that a bare `node -e ""` takes in the same run: that is the part of the
wait that is Node.js starting, not zn. See [How it is measured](#how-it-is-measured) above for the full method.

## The hook launcher on Windows

Claude Code, Antigravity and Gemini CLI start their hook through a small launcher script, which runs in Git Bash on Windows. Starting a program is slower on Windows, and Windows Defender scans each one, so what the launcher starts matters. On a Windows Server 2022 test machine with Defender on, a hook call through the launcher of earlier versions took a median of 383 ms (95th percentile 499 ms), against 132 ms (144 ms) for the check alone. The Windows launcher now starts one Node.js process and nothing else, and takes a median of 204 ms (95th percentile 220 ms). It keeps the same rules: a call is still blocked when zn-gate or Node.js is missing, when zn-gate changed since the hooks were installed, when the check fails or does not confirm its answer, or when it runs too long. One case is covered only by the agent's own hook timeout: a hang while Node.js itself starts, before zn-gate can start its timer. Run `zn hooks install` again, or update zn-gate, to switch an existing launcher to the new one.

## The budget in CI

The `Hook latency` workflow runs this benchmark on every pull request that changes the hook code. Each case
is compared with `bench/hook_latency_baseline.json` (the median of many runs) as its p95 divided by Node's start-up
in the same run. The run fails in two ways: one case more than 20 % above its baseline, or the whole run
slower, with the median of all cases more than 10 % above the baseline. The second check catches a change that
makes every case a little slower, which no single case would show. A case over the limit is measured again with twice the samples first,
so one slow sample does not fail it. The run fails too when the baseline file is missing. A deliberate change of the baseline is a commit of its own:
`node bench/hook_latency_gate.js report1.json report2.json ... --update-baseline`, which writes the median ratio of
every case over the reports given (use reports of several runs on `next`, from the workflow's artifacts).

The same benchmark also runs on a Windows runner, where starting a process is slower. That job has its own
baseline, `bench/hook_latency_baseline_windows.json`, and is not a required check: it reports but does not
block a merge. Its per-case margin is 35 % instead of 20 %: Windows runners come with several CPU models and
their timings vary about twice as much as on Linux, and with 20 % runs failed often with no code change.
The whole-run check (10 %) is the same on both. The summary of each run has one table with the Linux and Windows numbers side by side.
