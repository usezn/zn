#!/usr/bin/env bash
# Tests .github/scripts/quick-scope.sh: for each changed path, which checks of the "Quick checks" workflow run.
# Usage: bash .github/scripts/test-quick-scope.sh   (from the repository root; uses a temporary git repository)
set -euo pipefail

script="$(cd "$(dirname "$0")" && pwd)/quick-scope.sh"
work="$(mktemp -d "${TMPDIR:-/tmp}/quick-scope-test.XXXXXX")"
trap 'rm -rf "$work"' EXIT
fail=0

git -C "$work" init -q
git -C "$work" config user.email test@example.invalid
git -C "$work" config user.name test
echo base > "$work/base.txt"
git -C "$work" add -A
git -C "$work" commit -q -m base

# check "<event>" "<base ref or push ref>" "<changed path>" "<space separated checks that must be true>"
check() {
  local event="$1" ref="$2" path="$3" want="$4" before out got c
  before="$(git -C "$work" rev-parse HEAD)"
  mkdir -p "$work/$(dirname "$path")"
  echo "$RANDOM" > "$work/$path"
  git -C "$work" add -A
  git -C "$work" commit -q -m change
  if [ "$event" = "pull_request" ]; then
    out="$(cd "$work" && EVENT_NAME=pull_request BASE_REF="$ref" bash "$script")"
  else
    out="$(cd "$work" && EVENT_NAME=push REF="$ref" BEFORE="$before" bash "$script")"
  fi
  got=""
  for c in $(printf '%s\n' "$out" | sed -n 's/^\([a-z]*\)=true$/\1/p' | grep -v '^any$' | sort); do got="$got $c"; done
  got="${got# }"
  read -ra want_arr <<< "$want"
  want="$(printf '%s\n' "${want_arr[@]}" | sort | tr '\n' ' ')"; want="${want% }"
  if [ "$got" != "$want" ]; then
    echo "FAIL $event $ref $path: got [$got], want [$want]"
    fail=1
  fi
}

check pull_request next src/main.rs "changelog"
check pull_request next docs/cli.md "changelog markdownlint typos links snippets"
check pull_request main README.md "changelog markdownlint typos links snippets"
check pull_request next README-extra.md "changelog markdownlint typos links"
check pull_request next packages/zn-gate/README.md "changelog markdownlint typos links packagelint snippets"
check pull_request next packages/zn-gate/lib/a.js "changelog packagelint snippets"
check pull_request next packages/zn-gate/package.json "changelog packagelint snippets hooks"
check pull_request next packages/zn-gate-py/setup.py "changelog packagelint snippets"
check pull_request next changelog.d/x.md "changelog typos links"
check pull_request next changelog.d/README.md "changelog markdownlint typos links"
check pull_request next scripts/run.sh "changelog shellcheck"
check pull_request next .github/workflows/other.yml "changelog workflowlint"
check pull_request next action.yml "changelog workflowlint"
check pull_request next .github/package-lint-requirements.txt "changelog packagelint"
check pull_request next .pre-commit-hooks.yaml "changelog hooks"
check pull_request next .typos.toml "changelog typos"
check pull_request next .github/lychee.toml "changelog links"
check pull_request next .github/workflows/quick-checks.yml "changelog markdownlint typos links shellcheck workflowlint packagelint hooks snippets scopetest"
check pull_request next .github/scripts/test-quick-scope.sh "changelog shellcheck scopetest"
check push refs/heads/next .github/scripts/quick-scope.sh "markdownlint typos links shellcheck workflowlint packagelint hooks snippets scopetest"
check pull_request release/1.0 src/lib.rs "changelog"
check pull_request feature-base docs/cli.md "changelog"
check push refs/heads/main docs/cli.md "markdownlint snippets"
check push refs/heads/next docs/cli.md "markdownlint"
check push refs/heads/next scripts/run.sh "shellcheck"
check push refs/heads/main packages/zn-gate/package.json "packagelint snippets hooks"
check push refs/heads/release/1.0 docs/cli.md ""

# Manual runs run everything but the changelog check (pull requests only), the schedule runs only the doc snippets.
out="$(cd "$work" && EVENT_NAME=workflow_dispatch bash "$script")"
{ [ "$(printf '%s\n' "$out" | grep -c '=true$')" = 10 ] && printf '%s\n' "$out" | grep -qx 'changelog=false'; } || { echo "FAIL workflow_dispatch"; fail=1; }
out="$(cd "$work" && EVENT_NAME=schedule bash "$script")"
if ! { [ "$(printf '%s\n' "$out" | grep -c '=true$')" = 2 ] && printf '%s\n' "$out" | grep -qx 'snippets=true'; }; then
  echo "FAIL schedule"; fail=1
fi
# No usable base: run everything (the changelog check still needs a pull request).
out="$(cd "$work" && EVENT_NAME=push REF=refs/heads/main BEFORE=0000000000000000000000000000000000000000 bash "$script")"
{ [ "$(printf '%s\n' "$out" | grep -c '=true$')" = 10 ] && printf '%s\n' "$out" | grep -qx 'changelog=false'; } || { echo "FAIL push without before"; fail=1; }

[ "$fail" = 0 ] && echo "quick-scope: all cases pass"
exit "$fail"
