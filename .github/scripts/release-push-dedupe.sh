#!/usr/bin/env bash
# Decides whether a push to a release branch duplicates the pull request run of the same commit.
# Prints "skip=true" or "skip=false" to $GITHUB_OUTPUT (and to the log).
#
# A release branch usually has an open pull request into main (or into another release branch). A push to
# that branch starts this workflow twice on the same commit: once for the push, once for the pull request
# (the pull request run attaches its check runs to the same head commit). This script says "skip" only when
# all of these hold, so the pull request run provably covers the push run:
#   - the event is a push to refs/heads/release/*;
#   - an open pull request from that branch of this repository has this exact commit as its head, is not a
#     draft (draft pull requests skip their jobs) and targets main or a release branch (a pull request into
#     next runs only the sample of the checks, not the full matrix a release commit needs);
#   - this very workflow has a run for that pull request on that commit that is not cancelled or skipped
#     (a pull request with a merge conflict starts no run, and a workflow with a paths filter may not start).
# Everything else, and any error (API failure, odd output, no run yet after the retries), means skip=false:
# when in doubt, run the checks.
#
# Environment: GH_TOKEN, GH_REPO (owner/name), EVENT_NAME, REF, SHA, RUN_ID (the id of the run that calls
# this script), GITHUB_OUTPUT (optional). DEDUPE_TRIES and DEDUPE_WAIT (seconds) tune the wait for the pull
# request run, which starts a few seconds after the push run.
set -uo pipefail

out() { echo "skip=$1"; [ -n "${GITHUB_OUTPUT:-}" ] && echo "skip=$1" >> "$GITHUB_OUTPUT"; exit 0; }
why() { echo "dedupe: $*"; }

[ "${EVENT_NAME:-}" = "push" ] || { why "not a push"; out false; }
case "${REF:-}" in refs/heads/release/*) ;; *) why "not a release branch push"; out false ;; esac
[[ "${SHA:-}" =~ ^[0-9a-f]{40}$ ]] || { why "no commit sha"; out false; }
[ -n "${GH_REPO:-}" ] || { why "no repository"; out false; }

branch="${REF#refs/heads/}"
owner="${GH_REPO%%/*}"

prs="$(gh api -X GET "repos/$GH_REPO/pulls" -f state=open -f "head=$owner:$branch" -f per_page=30 2>/dev/null)" \
  || { why "could not list pull requests"; out false; }
nums="$(jq -c --arg sha "$SHA" --arg repo "$GH_REPO" '
  [.[] | select(.state == "open" and .draft == false and .head.sha == $sha and .head.repo.full_name == $repo
                and (.base.ref == "main" or (.base.ref | startswith("release/")))) | .number]' <<< "$prs" 2>/dev/null)" \
  || { why "unreadable pull request list"; out false; }
[ -n "$nums" ] && [ "$nums" != "[]" ] || { why "no open, ready pull request into main or a release branch has this commit as head"; out false; }
why "candidate pull requests: $nums"

wid="$(gh api "repos/$GH_REPO/actions/runs/${RUN_ID:-0}" --jq .workflow_id 2>/dev/null)" \
  || { why "could not read this run"; out false; }
[[ "$wid" =~ ^[0-9]+$ ]] || { why "no workflow id"; out false; }

tries="${DEDUPE_TRIES:-5}"
wait_s="${DEDUPE_WAIT:-8}"
i=0
while [ "$i" -lt "$tries" ]; do
  i=$((i + 1))
  runs="$(gh api -X GET "repos/$GH_REPO/actions/workflows/$wid/runs" -f event=pull_request -f "head_sha=$SHA" -f per_page=50 2>/dev/null)" || runs=""
  if [ -n "$runs" ]; then
    n="$(jq --argjson nums "$nums" '
      [.workflow_runs[]
       | select(.conclusion != "cancelled" and .conclusion != "skipped")
       | select(any(.pull_requests[]?; . as $p | $nums | index($p.number) != null))] | length' <<< "$runs" 2>/dev/null)" || n=0
    if [[ "$n" =~ ^[0-9]+$ ]] && [ "$n" -gt 0 ]; then
      why "the pull request run of this commit exists: this push run is a duplicate"
      out true
    fi
  fi
  [ "$i" -lt "$tries" ] && sleep "$wait_s"
done
why "no pull request run of this commit was found"
out false
