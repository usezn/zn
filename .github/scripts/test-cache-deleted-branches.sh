#!/usr/bin/env bash
# Tests .github/scripts/cache-deleted-branches.sh with made-up cache lists.
# Run from anywhere inside the repository: bash .github/scripts/test-cache-deleted-branches.sh
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
script="$root/.github/scripts/cache-deleted-branches.sh"
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
fails=0
t=$'\t'

printf 'main\nnext\nrelease/1.14.0\nfeature/live\n' > "$work/branches.txt"
printf 'feature/live\n' > "$work/only-live.txt"
: > "$work/empty.txt"

# check <label> <branches file> <expected ids, space separated> <input lines...>
check() {
  local label="$1" file="$2" expected="$3"; shift 3
  local got
  got="$(printf '%s\n' "$@" | bash "$script" "$file" 2>/dev/null | cut -f1 | sort -n | tr '\n' ' ' | sed 's/ $//')"
  if [ "$got" = "$expected" ]; then echo "ok   $label"; else echo "FAIL $label: expected [$expected], got [$got]"; fails=$((fails + 1)); fi
}
row() { printf '%s\tk%s\t%s\t%s\t%s' "$1" "$1" "$2" "$3" "2026-10-01T00:00:00Z"; }

check "cache of a deleted branch is listed" "$work/branches.txt" "1" \
  "$(row 1 refs/heads/feature/gone 100)" "$(row 2 refs/heads/feature/live 100)"
check "branches with a slash in the name are matched whole" "$work/branches.txt" "1" \
  "$(row 1 refs/heads/release/1.13.0 100)" "$(row 2 refs/heads/release/1.14.0 100)"
check "a prefix of an existing branch is not that branch" "$work/branches.txt" "1" \
  "$(row 1 refs/heads/feature 100)" "$(row 2 refs/heads/feature/live 100)"
check "merge queue refs are never listed" "$work/branches.txt" "" \
  "$(row 1 refs/heads/gh-readonly-queue/next/pr-5-abc 100)"
check "pull request refs and tags are never listed" "$work/branches.txt" "" \
  "$(row 1 refs/pull/5/merge 100)" "$(row 2 refs/tags/v1.0.0 100)"
check "main and next are kept even if the branch list lacks them" "$work/only-live.txt" "3" \
  "$(row 1 refs/heads/main 100)" "$(row 2 refs/heads/next 100)" "$(row 3 refs/heads/old 100)"
check "an empty branch list lists nothing" "$work/empty.txt" "" \
  "$(row 1 refs/heads/feature/gone 100)"

# Output columns: id, ref, size.
out="$(row 7 refs/heads/gone 4096 | bash "$script" "$work/branches.txt")"
if [ "$out" = "7${t}refs/heads/gone${t}4096" ]; then echo "ok   output columns"; else echo "FAIL output columns: [$out]"; fails=$((fails + 1)); fi

if [ "$fails" -gt 0 ]; then echo "$fails failed"; exit 1; fi
echo "all passed"
