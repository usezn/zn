#!/usr/bin/env bash
# Smoke test for the Node examples (examples/node-basic, examples/custom-rules, examples/openai-agents-js, examples/langchain-js, examples/vercel-ai-sdk, examples/mastra-agent).
#
# Packs packages/zn-gate with `npm pack`, installs the tarball into a copy of each example, and runs the
# example with no network (an empty network namespace) and no API keys. Each example must print the text
# it promises: a block verdict, a rejected tool result, or a custom rule firing.
#
# Usage: .github/scripts/examples-smoke-node.sh [--no-netns]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

NETNS=1
[ "${1:-}" = "--no-netns" ] && NETNS=0

# name|entry file|text that must appear|text that must not appear
EXAMPLES=(
  "node-basic|index.js|Verdict: block|Cannot find module"
  "node-basic|index.js|Safe to ingest: false|Cannot find module"
  "custom-rules|demo.js|Custom rule verdict: block|Cannot find module"
  "openai-agents-js|index.mjs|[REDACTED_AWS_KEY]|Cannot find module"
  "openai-agents-js|index.mjs|blocked the call to 'read_file'|Cannot find module"
  "langchain-js|index.js|zn-gate demo OK|zn-gate demo FAILED"
  "vercel-ai-sdk|index.mjs|[REDACTED_AWS_KEY]|Cannot find module"
  "vercel-ai-sdk|index.mjs|blocked the call to 'read_file'|Cannot find module"
  "mastra-agent|index.mjs|blocked the call to 'read_file'|Cannot find module"
)

echo "Packing packages/zn-gate"
(cd "$ROOT/packages/zn-gate" && npm pack --silent --ignore-scripts --pack-destination "$WORK" >/dev/null)
TARBALL="$(ls "$WORK"/zn-gate-*.tgz)"

declare -A OUT
for name in node-basic custom-rules openai-agents-js langchain-js vercel-ai-sdk mastra-agent; do
  entry="$(printf '%s\n' "${EXAMPLES[@]}" | awk -F'|' -v n="$name" '$1==n {print $2; exit}')"
  dir="$WORK/$name"
  mkdir "$dir"
  cp -a "$ROOT/examples/$name/." "$dir/"
  if [ -f "$dir/package-lock.json" ]; then
    # Examples with their own dependencies install them from the lockfile (the run itself stays offline),
    # then swap in the packed zn-gate.
    (cd "$dir" && npm ci --ignore-scripts --no-audit --no-fund >/dev/null && npm install --no-save --ignore-scripts --no-audit --no-fund "$TARBALL" >/dev/null)
  else
    # The tarball bundles its one dependency, so the install needs no registry.
    (cd "$dir" && npm init -y >/dev/null && npm install --offline --ignore-scripts --no-audit --no-fund "$TARBALL" >/dev/null)
  fi
  echo "Running examples/$name/$entry offline"
  run=(env -i PATH="$PATH" HOME="$WORK/home" node "$entry")
  mkdir -p "$WORK/home"
  if [ "$NETNS" = 1 ]; then
    run=(sudo -n unshare -n "${run[@]}")
  fi
  OUT[$name]="$(cd "$dir" && "${run[@]}" 2>&1)" || { echo "FAIL examples/$name exited with an error"; echo "${OUT[$name]}"; exit 1; }
  # shellcheck disable=SC2001 # the output has several lines: the prefix goes on every line, which ${var//} would not do
  echo "${OUT[$name]}" | sed 's/^/    /'
done

fail=0
for row in "${EXAMPLES[@]}"; do
  IFS='|' read -r name entry want nope <<<"$row"
  if ! grep -qF -- "$want" <<<"${OUT[$name]}"; then
    echo "FAIL examples/$name did not print: $want"; fail=1
  fi
  if grep -qF -- "$nope" <<<"${OUT[$name]}"; then
    echo "FAIL examples/$name printed: $nope"; fail=1
  fi
done
[ "$fail" = 0 ] || exit 1
echo "OK Node examples ran offline"
