#!/usr/bin/env bash
# Decides which checks of the "Quick checks" workflow (.github/workflows/quick-checks.yml) run for this change.
# Writes one "<name>=true|false" line per check to $GITHUB_OUTPUT (and to the log), plus "any=true|false".
#
# Each check keeps the trigger and the path filter it had when it was a workflow of its own:
#   changelog     pull requests, always
#   markdownlint  pull requests and pushes to main or next: docs, READMEs, markdownlint config
#   typos         pull requests: docs, READMEs, changelog fragments, .typos.toml
#   links         pull requests: any Markdown file, lychee config
#   shell lint    pull requests and pushes to main or next: any *.sh
#   workflowlint  pull requests and pushes to main or next: workflows, actions, zizmor config, action.yml
#   packagelint   pull requests and pushes to main or next: the two packages and their lint requirements
#   hooks         pull requests and pushes to main or next: the pre-commit hooks file and its test
#   snippets      pull requests, pushes to main, the nightly schedule: README, docs, packages
#   scopetest     pull requests and pushes to main or next: this script and its test
# A change to the workflow or to this script runs every check. Manual runs run every check, the schedule
# runs only the doc snippets, the changelog check runs only for a pull request (it compares the pull
# request with its base, which no other event has), and a pull request into a branch other than main, next or release/* runs only
# the changelog check. Any error while listing the files means true: when in doubt, run the check.
#
# Environment: EVENT_NAME, REF (github.ref), BASE_REF (pull requests), BEFORE (pushes: the previous tip).
set -uo pipefail

CHECKS="changelog markdownlint typos links shellcheck workflowlint packagelint hooks snippets scopetest"
declare -A run
for c in $CHECKS; do run[$c]=false; done

finish() {
  local any=false c
  # The changelog check needs a pull request: never for pushes, manual runs or the schedule.
  [ "${event:-}" = "pull_request" ] || run[changelog]=false
  for c in $CHECKS; do
    echo "$c=${run[$c]}"
    [ -n "${GITHUB_OUTPUT:-}" ] && echo "$c=${run[$c]}" >> "$GITHUB_OUTPUT"
    [ "${run[$c]}" = "true" ] && any=true
  done
  echo "any=$any"
  [ -n "${GITHUB_OUTPUT:-}" ] && echo "any=$any" >> "$GITHUB_OUTPUT"
  exit 0
}
all() { local c; for c in $CHECKS; do run[$c]=true; done; }
event="${EVENT_NAME:-}"

case "$event" in
  pull_request)
    run[changelog]=true
    case "${BASE_REF:-}" in
      main|next|release/*) ;;
      *) finish ;;
    esac
    ;;
  push)
    case "${REF:-}" in
      refs/heads/main|refs/heads/next) ;;
      *) finish ;;
    esac
    ;;
  schedule) run[snippets]=true; finish ;;
  *) all; finish ;;
esac

# The files this change touches. HEAD is the merge commit GitHub made for a pull request (HEAD^1 is the
# base tip); for a push it is the new tip and BEFORE the old one. --no-renames: a moved file counts at
# both paths, as it does for a paths filter.
files=""
if [ "$event" = "pull_request" ]; then
  files="$(git diff --no-renames --name-only HEAD^1 HEAD 2>/dev/null)" || { all; finish; }
else
  [[ "${BEFORE:-}" =~ ^[0-9a-f]{40}$ ]] && [[ "$BEFORE" != 0000000000000000000000000000000000000000 ]] || { all; finish; }
  files="$(git diff --no-renames --name-only "$BEFORE" HEAD 2>/dev/null)" || { all; finish; }
fi
[ -n "$files" ] || { all; finish; }

OWN_WORKFLOW=.github/workflows/quick-checks.yml
OWN_SCRIPT=.github/scripts/quick-scope.sh
while IFS= read -r f; do
  case "$f" in
    "$OWN_WORKFLOW"|"$OWN_SCRIPT") all; finish ;;
  esac
  readme_root=false
  case "$f" in README*) [[ "$f" != */* ]] && readme_root=true ;; esac
  case "$f" in
    docs/*|packages/*/README.md|.markdownlint-cli2.jsonc|.github/markdownlint/*|changelog.d/README.md) run[markdownlint]=true ;;
  esac
  [ "$readme_root" = "true" ] && [[ "$f" == README*.md ]] && run[markdownlint]=true
  case "$f" in
    docs/*|packages/*/README.md|changelog.d/*|.typos.toml) run[typos]=true ;;
  esac
  [ "$readme_root" = "true" ] && run[typos]=true
  case "$f" in
    *.md|.github/lychee.toml) run[links]=true ;;
  esac
  case "$f" in
    *.sh) run[shellcheck]=true ;;
  esac
  case "$f" in
    .github/workflows/*|.github/actions/*|.github/workflow-lint/*|.github/zizmor.yml|action.yml) run[workflowlint]=true ;;
  esac
  case "$f" in
    packages/zn-gate/*|packages/zn-gate-py/*|.github/package-lint-requirements.txt|.github/release-requirements.txt) run[packagelint]=true ;;
  esac
  case "$f" in
    .pre-commit-hooks.yaml|.github/scripts/test-pre-commit-hooks.sh|packages/zn-gate/package.json) run[hooks]=true ;;
  esac
  case "$f" in
    .github/scripts/test-quick-scope.sh) run[scopetest]=true ;;
  esac
  case "$f" in
    docs/*|packages/*|README.md|.github/scripts/doc-snippets*) run[snippets]=true ;;
  esac
done <<< "$files"

# Doc snippets run for pull requests and pushes to main only (not for a push to next).
if [ "$event" = "push" ] && [ "${REF:-}" != "refs/heads/main" ]; then run[snippets]=false; fi
# Spelling and links are checked on pull requests only.
if [ "$event" = "push" ]; then run[typos]=false; run[links]=false; fi
finish
