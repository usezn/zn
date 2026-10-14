#!/usr/bin/env bash
# Decides whether the JavaScript and Python checks need to run for this change.
# Prints "run=true" or "run=false" to $GITHUB_OUTPUT (and to the log).
#
# Always true outside pull requests (pushes, tags, manual runs) and when the full
# matrix was asked for. For a pull request, false only when every changed file is
# documentation or belongs to the Rust gateway (checked by its own workflow).
# Anything under packages/, plugins/, skill/, bench/ or .github/ always needs the
# checks, Markdown files included (some are checked by the package and plugin checks).
# Any error while listing the files means true: when in doubt, run the checks.
set -uo pipefail

out() { echo "run=$1"; [ -n "${GITHUB_OUTPUT:-}" ] && echo "run=$1" >> "$GITHUB_OUTPUT"; exit 0; }

[ "${EVENT_NAME:-}" = "pull_request" ] || out true
[ "${FULL:-false}" = "true" ] && out true
[[ "${BASE_SHA:-}" =~ ^[0-9a-f]{40}$ ]] || out true

git fetch --no-tags --depth=1 origin "$BASE_SHA" >/dev/null 2>&1 || out true
# --no-renames: a file moved out of the code into docs/ counts for both paths.
files="$(git diff --no-renames --name-only "$BASE_SHA" HEAD 2>/dev/null)" || out true
[ -n "$files" ] || out true

needed=false
while IFS= read -r f; do
  case "$f" in
    packages/*|plugins/*|skill/*|bench/*|action.yml|.github/*) needed=true; echo "needs the checks: $f"; break ;;
    docs/*|*.md|LICENSE|NOTICE|assets/*) ;;   # documentation
    src/*|Cargo.toml|Cargo.lock|.cargo/*|build.rs) ;;   # Rust gateway
    *) needed=true; echo "needs the checks: $f"; break ;;
  esac
done <<< "$files"
out "$needed"
