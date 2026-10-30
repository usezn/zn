#!/usr/bin/env bash
# Decides whether the Rust gateway checks (fmt, clippy, build, test) need to run for this change.
# Prints "rust=true" or "rust=false" to $GITHUB_OUTPUT (and to the log).
#
# Always true outside pull requests and the merge queue (pushes, tags, schedule, manual runs). For a
# pull request or a merge queue group (compared with its base commit), true
# when any changed file is something cargo reads: src/, Cargo.toml, Cargo.lock, .cargo/, build.rs,
# benches/, tests/, rust-toolchain files, this workflow and script, or a file a Rust test reads from the
# Node.js package (the invisible-character table, the override grammar and the card, SSN and phone checks, and
# their shared fixtures, including the benign-phrase list: src/engine/rules.rs, src/prompt_guard/mod.rs and src/scrubber/mod.rs must match them).
# Any error while listing the files means true: when in doubt, run the checks.
set -uo pipefail

out() { echo "rust=$1"; [ -n "${GITHUB_OUTPUT:-}" ] && echo "rust=$1" >> "$GITHUB_OUTPUT"; exit 0; }

case "${EVENT_NAME:-}" in pull_request|merge_group) ;; *) out true ;; esac
[[ "${BASE_SHA:-}" =~ ^[0-9a-f]{40}$ ]] || out true

git fetch --no-tags --depth=1 origin "$BASE_SHA" >/dev/null 2>&1 || out true
# --no-renames: a file moved out of the Rust tree counts for both paths.
files="$(git diff --no-renames --name-only "$BASE_SHA" HEAD 2>/dev/null)" || out true
[ -n "$files" ] || out true

needed=false
while IFS= read -r f; do
  case "$f" in
    packages/zn-gate/lib/invisible.js|packages/zn-gate/lib/rules.js|packages/zn-gate/lib/scrub/patterns.js|packages/zn-gate/test/fixtures/benign_phrases.json|packages/zn-gate/test/fixtures/invisible_chars.json|packages/zn-gate/test/fixtures/prompt_guard_tables.json|packages/zn-gate/test/fixtures/scrub_validator_cases.json|src/*|Cargo.toml|Cargo.lock|.cargo/*|build.rs|benches/*|tests/*|rust-toolchain|rust-toolchain.toml|.github/workflows/rust.yml|.github/scripts/rust-scope.sh)
      needed=true; echo "needs the Rust checks: $f"; break ;;
  esac
done <<< "$files"
out "$needed"
