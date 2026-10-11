# Scrubber engine latency

In-process `tokenize()` with every layer (exact values, patterns, PII), an in-memory vault and real code as input (files from the benign corpus). Reproduce with:

```bash
node bench/scrub_latency.js
```

"Dense" inputs carry a fake secret or PII value about every 1 KB. All values are fake (`packages/zn-gate/test/fixtures/fake_secrets.js`).

## Measured on 2026-10-11

### AMD Ryzen 7 9700X (16 threads), Windows 11, Node 24.12

| Size | benign p50 / p95 / p99 | dense p50 / p95 / p99 |
|---|---|---|
| 256 B | 0.005 / 0.013 / 0.023 ms | 0.004 / 0.006 / 0.020 ms |
| 4 KB | 0.031 / 0.055 / 0.103 ms | 0.048 / 0.074 / 0.115 ms |
| 64 KB | 0.494 / 0.531 / 0.604 ms | 1.035 / 1.275 / 1.546 ms |

Cold process (load the engine and tokenize 4 KB once): p50 49.3 ms, against 37.2 ms for a bare `node -e 0`.

### Intel Xeon Platinum 8259CL (2 vCPU, AWS), Linux, Node 24.21, load average 1.2

| Size | benign p50 / p95 / p99 | dense p50 / p95 / p99 |
|---|---|---|
| 256 B | 0.024 / 0.069 / 0.158 ms | 0.022 / 0.040 / 0.094 ms |
| 4 KB | 0.118 / 0.249 / 0.382 ms | 0.189 / 0.418 / 0.658 ms |
| 64 KB | 1.555 / 2.465 / 4.071 ms | 3.408 / 4.886 / 5.225 ms |

Cold process: p50 69.5 ms, against 45.0 ms for a bare `node -e 0`.

### GitHub-hosted runners (leak bench, benign corpus payload)

| Runner | 256 B p50 / p95 | 4 KB p50 / p95 | 64 KB p50 / p95 |
|---|---|---|---|
| ubuntu-latest, Node 20 | 0.008 / 0.009 ms | 0.085 / 0.099 ms | 1.495 / 1.591 ms |
| ubuntu-latest, Node 24 | 0.006 / 0.010 ms | 0.069 / 0.081 ms | 1.129 / 1.160 ms |
| macos-latest, Node 20 | 0.004 / 0.005 ms | 0.056 / 0.067 ms | 0.944 / 1.082 ms |
| macos-latest, Node 24 | 0.004 / 0.006 ms | 0.058 / 0.078 ms | 0.881 / 1.086 ms |

## Gate in the leak bench

| Size | p50 limit | p95 limit |
|---|---|---|
| 256 B | 0.5 ms | 2 ms |
| 4 KB | 1 ms | 3 ms |
| 64 KB | 5 ms | 10 ms |

The limits leave about 3x headroom over the slowest machine measured. A whole hook process also pays Node startup, which dominates: tens of milliseconds against one or two for the engine.
