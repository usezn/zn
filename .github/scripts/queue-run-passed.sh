#!/usr/bin/env bash
# Tells a workflow whether this push to next is a commit the merge queue already tested with that workflow.
# Prints "already_passed=true" or "already_passed=false" to stdout and to $GITHUB_OUTPUT.
#
# True only when ALL of these hold, otherwise false (run everything, as before):
#   - the event is a push to refs/heads/next;
#   - a merge_group run of the workflow WORKFLOW_PATH exists for exactly this commit SHA, on a
#     gh-readonly-queue/next/ branch, and it completed with success;
#   - in that run, every job named in REPEATED_JOBS (one name per line) finished with success.
# Any API error, missing run, run still going, other conclusion or unexpected output means false.
#
# Needs: gh and jq, GH_TOKEN with actions: read.
# Env: EVENT_NAME, REF, SHA, REPO, WORKFLOW_PATH (for example .github/workflows/scrubber.yml), REPEATED_JOBS.
set -uo pipefail

out() { echo "already_passed=$1"; [ -n "${GITHUB_OUTPUT:-}" ] && echo "already_passed=$1" >> "$GITHUB_OUTPUT"; exit 0; }
why() { echo "queue gate: $*" >&2; }

[ "${EVENT_NAME:-}" = "push" ] || { why "not a push"; out false; }
[ "${REF:-}" = "refs/heads/next" ] || { why "not next"; out false; }
[[ "${SHA:-}" =~ ^[0-9a-f]{40}$ ]] || { why "bad sha"; out false; }
[[ "${REPO:-}" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] || { why "bad repo"; out false; }
wf="${WORKFLOW_PATH:-}"
[[ "$wf" =~ ^\.github/workflows/[A-Za-z0-9._-]+\.yml$ ]] || { why "bad workflow path"; out false; }
[ -n "${REPEATED_JOBS//[[:space:]]/}" ] || { why "no jobs to compare"; out false; }

runs="$(gh api "repos/$REPO/actions/runs?head_sha=$SHA&event=merge_group&per_page=100" 2>/dev/null)" \
  || { why "could not list runs"; out false; }
ids="$(jq -r --arg wf "$wf" --arg sha "$SHA" '
  [.workflow_runs[]?
   | select(((.path // "") | split("@")[0]) == $wf and .status == "completed" and .conclusion == "success"
            and .head_sha == $sha and (.head_branch | strings | startswith("gh-readonly-queue/next/")))
   | .id] | .[]' <<< "$runs" 2>/dev/null)" || { why "unreadable runs"; out false; }
[ -n "$ids" ] || { why "no successful merge_group run of $wf for this sha"; out false; }

for id in $ids; do
  jobs="$(gh api "repos/$REPO/actions/runs/$id/jobs?filter=latest&per_page=100" 2>/dev/null)" || continue
  ok=true
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    n="$(jq -r --arg n "$name" '[.jobs[]? | select(.name == $n and .conclusion == "success")] | length' <<< "$jobs" 2>/dev/null)" || n=0
    [ "${n:-0}" -ge 1 ] || { ok=false; why "run $id: job not successful: $name"; break; }
  done <<< "$REPEATED_JOBS"
  if [ "$ok" = true ]; then why "run $id passed every repeated job for $SHA"; out true; fi
done
out false
