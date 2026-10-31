#!/usr/bin/env bash
# Decides whether the JavaScript and Python checks need to run for this change.
# Prints "run=true" or "run=false" to $GITHUB_OUTPUT (and to the log).
#
# Always true outside pull requests (pushes, tags, manual runs) and when the full
# matrix was asked for. For a pull request, false only when every changed file is
# documentation or belongs to the Rust gateway (checked by its own workflow, whose required job always
# reports). Documentation files that tests read (docs/cli.md, ...) count as code.
# Anything under packages/, plugins/, skill/, bench/ or .github/ always needs the
# checks, Markdown files included (some are checked by the package and plugin checks).
# With SCOPE=core (scrubber, leak bench) examples/ and the other workflows' files do not count.
# A Rust-only change needs no JS or Python check: no JS or Python test reads a .rs file. The Rust-to-Node
# parity test (invisible_table_equals_shared_fixture) is a cargo test, so the required Rust job runs it,
# and rust-scope.sh also runs that job when the Node side of the parity (invisible.js, its fixture) changes.
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
# SCOPE=core (scrubber and leak bench): examples and other workflows' files do not need these checks;
# OWN names the calling workflow file, which always does.
if [ "${SCOPE:-}" = "core" ]; then
  while IFS= read -r f; do
    case "$f" in
      "${OWN:-.github/workflows/none}"|.github/scripts/ci-scope.sh|.github/actions/*) needed=true; echo "needs the checks: $f"; break ;;
      packages/*/*.md|plugins/*.md) needed=true; echo "needs the checks: $f"; break ;;
      examples/*|.github/*|docs/*|*.md|LICENSE|NOTICE|assets/*) ;;
      src/*|Cargo.toml|Cargo.lock|.cargo/*|build.rs) ;;
      *) needed=true; echo "needs the checks: $f"; break ;;
    esac
  done <<< "$files"
  out "$needed"
fi
while IFS= read -r f; do
  case "$f" in
    packages/*|plugins/*|skill/*|bench/*|action.yml|.github/*) needed=true; echo "needs the checks: $f"; break ;;
    # Documentation files a test reads. Keep in step with the tests: test-ci-scope.sh fails when a
    # test mentions a docs file that is not listed here.
    docs/api-reference.md|docs/audit.md|docs/check.md|docs/cli.md) needed=true; echo "needs the checks (a test reads it): $f"; break ;;
    docs/*|*.md|LICENSE|NOTICE|assets/*) ;;   # documentation
    src/*|Cargo.toml|Cargo.lock|.cargo/*|build.rs) ;;   # Rust gateway
    *) needed=true; echo "needs the checks: $f"; break ;;
  esac
done <<< "$files"
out "$needed"
