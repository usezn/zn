#!/usr/bin/env bash
# Decides whether the Rust gateway checks (fmt, clippy, build, test) need to run for this change.
# Prints "rust=true" or "rust=false" to $GITHUB_OUTPUT (and to the log).
#
# Always true outside pull requests (pushes, tags, schedule, manual runs). For a pull request, true
# when any changed file is something cargo reads: src/, Cargo.toml, Cargo.lock, .cargo/, build.rs,
# benches/, tests/, rust-toolchain files, or this workflow and script.
# Any error while listing the files means true: when in doubt, run the checks.
set -uo pipefail

out() { echo "rust=$1"; [ -n "${GITHUB_OUTPUT:-}" ] && echo "rust=$1" >> "$GITHUB_OUTPUT"; exit 0; }

[ "${EVENT_NAME:-}" = "pull_request" ] || out true
[[ "${BASE_SHA:-}" =~ ^[0-9a-f]{40}$ ]] || out true

git fetch --no-tags --depth=1 origin "$BASE_SHA" >/dev/null 2>&1 || out true
# --no-renames: a file moved out of the Rust tree counts for both paths.
files="$(git diff --no-renames --name-only "$BASE_SHA" HEAD 2>/dev/null)" || out true
[ -n "$files" ] || out true

needed=false
while IFS= read -r f; do
  case "$f" in
    src/*|Cargo.toml|Cargo.lock|.cargo/*|build.rs|benches/*|tests/*|rust-toolchain|rust-toolchain.toml|.github/workflows/rust.yml|.github/scripts/rust-scope.sh)
      needed=true; echo "needs the Rust checks: $f"; break ;;
  esac
done <<< "$files"
out "$needed"
