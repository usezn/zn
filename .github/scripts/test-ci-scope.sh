#!/usr/bin/env bash
# Tests .github/scripts/ci-scope.sh and rust-scope.sh against throwaway git repositories.
# Run from anywhere inside the repository: bash .github/scripts/test-ci-scope.sh
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
scripts="$root/.github/scripts"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
fails=0
n=0

# scope <script> <expected> <label> <file>...
# Commits the files, then a change to each, and runs the script as a pull request would
# (or as SCOPE_EVENT, for example merge_group).
scope() {
  local script="$1" expected="$2" label="$3"; shift 3
  n=$((n + 1))
  local repo="$work/r$n" f
  git init -q "$repo"
  (
    cd "$repo"
    git config user.email t@example.invalid; git config user.name t
    git remote add origin "$repo"
    for f in "$@"; do mkdir -p "$(dirname "$f")"; echo base > "$f"; done
    git add -A; git commit -q -m base
    local base; base="$(git rev-parse HEAD)"
    for f in "$@"; do echo changed >> "$f"; done
    git add -A; git commit -q -m change
    local got
    got="$(EVENT_NAME="${SCOPE_EVENT:-pull_request}" BASE_SHA="$base" FULL=false bash "$scripts/$script" | grep -E '^(run|rust)=')"
    if [ "${got#*=}" = "$expected" ]; then echo "ok   $label"; else echo "FAIL $label: expected $expected, got $got"; exit 1; fi
  ) || fails=$((fails + 1))
}

# ci-scope.sh: the Node and Python jobs
scope ci-scope.sh false "docs-only change to a file no test reads skips" docs/glossary.md
scope ci-scope.sh false "Markdown at the repository root skips" README.md
scope ci-scope.sh true  "docs/cli.md (read by a test) runs" docs/cli.md
scope ci-scope.sh true  "docs/api-reference.md (read by a test) runs" docs/api-reference.md
scope ci-scope.sh true  "docs/check.md (read by a test) runs" docs/check.md
scope ci-scope.sh true  "docs/audit.md (read by a test) runs" docs/audit.md
scope ci-scope.sh true  "docs file read by a test plus an unread one runs" docs/glossary.md docs/cli.md
scope ci-scope.sh false "Rust-only change skips the Node and Python jobs" src/main.rs Cargo.lock
scope ci-scope.sh true  "package change runs" packages/zn-gate/lib/x.js
scope ci-scope.sh true  "workflow change runs" .github/workflows/ci.yml

# rust-scope.sh: the Rust gateway job
scope rust-scope.sh true  "Rust-only change runs the Rust job" src/engine/watcher.rs
scope rust-scope.sh true  "Cargo.lock change runs the Rust job" Cargo.lock
scope rust-scope.sh true  "build.rs change runs the Rust job" build.rs
scope rust-scope.sh true  "benches/ change runs the Rust job" benches/b.rs
scope rust-scope.sh true  "tests/ change runs the Rust job" tests/t.rs
scope rust-scope.sh true  "rust-toolchain change runs the Rust job" rust-toolchain.toml
scope rust-scope.sh true  "rust.yml change runs the Rust job" .github/workflows/rust.yml
scope rust-scope.sh true  "invisible-character fixture (read by a Rust test) runs the Rust job" packages/zn-gate/test/fixtures/invisible_chars.json
scope rust-scope.sh true  "invisible.js (must match rules.rs) runs the Rust job" packages/zn-gate/lib/invisible.js
scope rust-scope.sh true  "rules.js (override grammar, rule ids; must match prompt_guard) runs the Rust job" packages/zn-gate/lib/rules.js
scope rust-scope.sh true  "scrub/patterns.js (card, SSN, phone checks; must match the Rust scrubber) runs the Rust job" packages/zn-gate/lib/scrub/patterns.js
scope rust-scope.sh true  "prompt guard fixture (read by a Rust test) runs the Rust job" packages/zn-gate/test/fixtures/prompt_guard_tables.json
scope rust-scope.sh true  "scrub validator fixture (read by a Rust test) runs the Rust job" packages/zn-gate/test/fixtures/scrub_validator_cases.json
scope rust-scope.sh true  "Rust rules change runs the Rust job, which holds the parity test" src/engine/rules.rs
scope rust-scope.sh false "docs-only change skips the Rust job" docs/cli.md
scope rust-scope.sh false "package-only change skips the Rust job" packages/zn-gate/lib/x.js
SCOPE_EVENT=merge_group scope rust-scope.sh true  "merge queue group with a Rust change runs the Rust job" src/main.rs
SCOPE_EVENT=merge_group scope rust-scope.sh false "merge queue group without a Rust change skips the Rust job" docs/cli.md

# Outside pull requests both scripts always run.
n=$((n + 1))
if [ "$(EVENT_NAME=push bash "$scripts/ci-scope.sh")" = "run=true" ] && [ "$(EVENT_NAME=push bash "$scripts/rust-scope.sh")" = "rust=true" ]; then
  echo "ok   push events always run"
else echo "FAIL push events always run"; fails=$((fails + 1)); fi

# Completeness: every docs/*.md path a test mentions must be treated as code by ci-scope.sh, or be listed
# here as a mention that reads nothing (a path inside a fixture or command string, or a comment).
cd "$root"
# docs/extra.md and docs/plain.md are in-memory file names in audit_instruction_imports.test.js, and docs/uninstall.md is
# a command string in the destructive-command corpus, and docs/x.md is a path inside a policy fixture: no test reads those real files.
allow_unread=" docs/connect.md docs/guide.md docs/troubleshooting.md docs/extra.md docs/plain.md docs/uninstall.md docs/x.md "
while IFS= read -r p; do
  case "$allow_unread" in *" $p "*) continue ;; esac
  n=$((n + 1))
  case "$p" in
    docs/*/*) continue ;;
  esac
  got="$(cd "$work" && rm -rf c && git init -q c && cd c && git config user.email t@example.invalid && git config user.name t \
    && git remote add origin "$work/c" && mkdir -p docs && echo a > "$p" && git add -A && git commit -q -m b \
    && base="$(git rev-parse HEAD)" && echo b >> "$p" && git add -A && git commit -q -m c \
    && EVENT_NAME=pull_request BASE_SHA="$base" FULL=false bash "$scripts/ci-scope.sh" | grep -E '^run=')"
  if [ "$got" = "run=true" ]; then echo "ok   $p is code (a test mentions it)"; else echo "FAIL $p is mentioned by a test but ci-scope.sh skips it: add it to ci-scope.sh (or to allow_unread if no test reads it)"; fails=$((fails + 1)); fi
done < <(grep -rhoE 'docs/[A-Za-z0-9_-]+\.md' packages/*/test packages/zn-gate-py/tests 2>/dev/null | sort -u)

echo "$n checks, $fails failed"
[ "$fails" -eq 0 ]
