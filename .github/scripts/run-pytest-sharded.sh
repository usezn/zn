#!/usr/bin/env bash
# Runs the Python package tests as three pytest processes at the same time: each of the two long
# linear-time and oversize-input test files in its own process, every other test in the third. These two
# files take about two thirds of the time of a sequential run, and the runner has idle cores.
# Run it from packages/zn-gate-py. Every test still runs exactly once, and the script fails when any
# process fails.
# Usage: run-pytest-sharded.sh [python-executable]
set -uo pipefail

py="${1:-python}"
heavy=(tests/test_rules_redos.py tests/test_result_oversize_block.py)
log_dir="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"

ignores=()
for f in "${heavy[@]}"; do
  [ -f "$f" ] || { echo "run-pytest-sharded: $f does not exist; update the list in this script" >&2; exit 2; }
  ignores+=("--ignore=$f")
done

pids=()
logs=()
for f in "${heavy[@]}"; do
  log="$log_dir/pytest-$(basename "$f" .py).log"
  "$py" -m pytest "$f" -v >"$log" 2>&1 &
  pids+=($!)
  logs+=("$log")
done
log="$log_dir/pytest-rest.log"
"$py" -m pytest tests/ "${ignores[@]}" -v >"$log" 2>&1 &
pids+=($!)
logs+=("$log")

rc=0
for pid in "${pids[@]}"; do
  wait "$pid" || rc=1
done

for log in "${logs[@]}"; do
  echo "::group::pytest log: $(basename "$log")"
  cat "$log"
  echo "::endgroup::"
done
for log in "${logs[@]}"; do
  echo "$(basename "$log"): $(tail -n 1 "$log")"
done
exit "$rc"
