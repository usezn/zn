### Added
- `zn-gate check` (and `doctor`) ends with the decision time per tool call: p50 and p95 of the last 100 calls, measured on this machine. Decision time excludes process startup, writing the response, and saving stats and evidence. It is stored locally in `~/.zn/stats.json` as numbers only, and shows `no data yet` until zn has checked a tool call.
