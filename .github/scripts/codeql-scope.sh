#!/usr/bin/env bash
# Decides which CodeQL languages a run can skip. Prints "skip=<languages>" (space-separated) to $GITHUB_OUTPUT
# and the log. A language is listed only in a pull request whose changed files contain nothing CodeQL reads for it:
#   actions                 .github/workflows, composite actions (action.yml)
#   javascript-typescript   JavaScript and TypeScript files, anywhere in the repository
#   python                  Python files and packages/zn-gate-py
#   rust                    Rust files and the Cargo manifests, lock files, build scripts and toolchain settings
# Pushes, tags, the weekly run, manual runs and merge groups skip nothing: they analyse all four languages.
# A change to this script or to codeql.yml skips nothing. Any error while listing the files skips nothing too:
# when in doubt, analyse.
set -uo pipefail

emit() { echo "skip=$1"; [ -n "${GITHUB_OUTPUT:-}" ] && echo "skip=$1" >> "$GITHUB_OUTPUT"; exit 0; }

[ "${EVENT_NAME:-}" = "pull_request" ] || emit ""
[[ "${BASE_SHA:-}" =~ ^[0-9a-f]{40}$ ]] || emit ""

git fetch --no-tags --depth=1 origin "$BASE_SHA" >/dev/null 2>&1 || emit ""
# --no-renames: a file moved out of a language's tree counts for both paths.
files="$(git diff --no-renames --name-only "$BASE_SHA" HEAD 2>/dev/null)" || emit ""
[ -n "$files" ] || emit ""

actions=false; js=false; py=false; rust=false
while IFS= read -r f; do
  case "$f" in
    .github/scripts/codeql-scope.sh|.github/workflows/codeql.yml) emit "" ;;
  esac
  case "$f" in
    .github/workflows/*|.github/actions/*|*action.yml|*action.yaml) actions=true ;;
  esac
  case "$f" in
    *.js|*.jsx|*.mjs|*.cjs|*.ts|*.tsx|*.mts|*.cts|*.vue|*.html|*.htm|package.json|*/package.json|tsconfig*.json|*/tsconfig*.json|packages/zn-gate/*) js=true ;;
  esac
  case "$f" in
    *.py|*.pyi|setup.py|*/setup.py|setup.cfg|*/setup.cfg|pyproject.toml|*/pyproject.toml|packages/zn-gate-py/*) py=true ;;
  esac
  case "$f" in
    *.rs|Cargo.toml|*/Cargo.toml|Cargo.lock|*/Cargo.lock|build.rs|*/build.rs|.cargo/*|*/.cargo/*|rust-toolchain|rust-toolchain.toml|*/rust-toolchain|*/rust-toolchain.toml) rust=true ;;
  esac
done <<< "$files"

skip=""
[ "$actions" = true ] || skip="$skip actions"
[ "$js" = true ] || skip="$skip javascript-typescript"
[ "$py" = true ] || skip="$skip python"
[ "$rust" = true ] || skip="$skip rust"
skip="${skip# }"
echo "changed files: $(wc -l <<< "$files" | tr -d ' ')"
echo "languages needed: actions=$actions javascript-typescript=$js python=$py rust=$rust"
emit "$skip"
