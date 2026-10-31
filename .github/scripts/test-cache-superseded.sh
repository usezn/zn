#!/usr/bin/env bash
# Tests .github/scripts/cache-superseded.sh with made-up cache lists.
# Run from anywhere inside the repository: bash .github/scripts/test-cache-superseded.sh
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
script="$root/.github/scripts/cache-superseded.sh"
fails=0
t=$'\t'
sha1=0123456789abcdef0123456789abcdef01234567
sha2=89abcdef0123456789abcdef0123456789abcdef

# check <label> <expected ids, space separated> <input lines...>
check() {
  local label="$1" expected="$2"; shift 2
  local got
  got="$(printf '%s\n' "$@" | bash "$script" | cut -f1 | sort -n | tr '\n' ' ' | sed 's/ $//')"
  if [ "$got" = "$expected" ]; then
    echo "ok   $label"
  else
    echo "FAIL $label: expected [$expected], got [$got]"
    fails=$((fails + 1))
  fi
}

main=refs/heads/main
check "old lock file hash of a family is superseded" "1" \
  "1${t}v0-rust-check-Linux-x64-aaaaaaaa-11111111${t}$main${t}100${t}2026-10-01T00:00:00Z" \
  "2${t}v0-rust-check-Linux-x64-bbbbbbbb-22222222${t}$main${t}100${t}2026-10-02T00:00:00Z"
check "two caches with the newest lock file hash are both kept" "" \
  "1${t}v0-rust-private-file-Darwin-arm64-aaaaaaaa-22222222${t}$main${t}100${t}2026-10-02T00:00:00Z" \
  "2${t}v0-rust-private-file-Darwin-arm64-bbbbbbbb-22222222${t}$main${t}100${t}2026-10-02T00:01:00Z"
check "families do not affect each other" "" \
  "1${t}v0-rust-check-Linux-x64-aaaaaaaa-11111111${t}$main${t}100${t}2026-10-01T00:00:00Z" \
  "2${t}v0-rust-msrv-Linux-x64-bbbbbbbb-22222222${t}$main${t}100${t}2026-10-02T00:00:00Z" \
  "3${t}v0-rust-fuzz-Linux-x64-cccccccc-33333333${t}$main${t}100${t}2026-10-03T00:00:00Z"
check "caches of other refs are never listed" "" \
  "1${t}v0-rust-check-Linux-x64-aaaaaaaa-11111111${t}refs/pull/5/merge${t}100${t}2026-10-01T00:00:00Z" \
  "2${t}v0-rust-check-Linux-x64-bbbbbbbb-22222222${t}refs/heads/next${t}100${t}2026-10-02T00:00:00Z"
check "only the newest CodeQL base database of a language is kept" "1 3" \
  "1${t}codeql-overlay-base-database-1-c801913f1ee29663-javascript-2.27.3-$sha1-40000000001-1${t}$main${t}100${t}2026-10-01T00:00:00Z" \
  "2${t}codeql-overlay-base-database-1-c801913f1ee29663-javascript-2.27.3-$sha2-40000000002-1${t}$main${t}100${t}2026-10-03T00:00:00Z" \
  "3${t}codeql-overlay-base-database-1-c801913f1ee29663-javascript-2.27.3-$sha1-40000000003-1${t}$main${t}100${t}2026-10-02T00:00:00Z" \
  "4${t}codeql-overlay-base-database-1-d953d79b74456ce0-python-2.27.3-$sha2-40000000004-1${t}$main${t}100${t}2026-10-01T00:00:00Z"
check "other keys are ignored" "" \
  "1${t}node-cache-macOS-arm64-npm-abc${t}$main${t}100${t}2026-10-01T00:00:00Z" \
  "2${t}node-cache-macOS-arm64-npm-def${t}$main${t}100${t}2026-10-02T00:00:00Z"

if [ "$fails" -gt 0 ]; then echo "$fails failed"; exit 1; fi
echo "all passed"
