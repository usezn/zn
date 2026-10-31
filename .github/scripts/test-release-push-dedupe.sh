#!/usr/bin/env bash
# Tests .github/scripts/release-push-dedupe.sh with a fake gh that answers from canned JSON.
# Run from anywhere inside the repository: bash .github/scripts/test-release-push-dedupe.sh
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
script="$root/.github/scripts/release-push-dedupe.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
fails=0
n=0
sha=0123456789abcdef0123456789abcdef01234567
other=89abcdef0123456789abcdef0123456789abcdef

mkdir -p "$work/bin"
# The fake gh: the pull request list, the run lookup and the workflow run list come from files in $FAKE;
# a file named fail-<kind> makes that call fail; every call is logged.
cat > "$work/bin/gh" <<'EOF'
#!/usr/bin/env bash
echo "$*" >> "$FAKE/calls.log"
case "$*" in
  *"/pulls"*) kind=pulls ;;
  *"/actions/runs/"*) kind=run ;;
  *"/actions/workflows/"*) kind=wfruns ;;
  *) exit 2 ;;
esac
[ -e "$FAKE/fail-$kind" ] && exit 1
# The run lookup is asked with --jq .workflow_id, which the real gh applies itself.
if [ "$kind" = run ]; then jq -r .workflow_id "$FAKE/run.json"; else cat "$FAKE/$kind.json"; fi
EOF
chmod +x "$work/bin/gh"

# pr <number> <draft> <head sha> <base> <repo>
pr() { printf '{"number":%s,"state":"open","draft":%s,"head":{"sha":"%s","repo":{"full_name":"%s"}},"base":{"ref":"%s"}}' "$1" "$2" "$3" "$5" "$4"; }
# wfrun <conclusion|null> <pull request number>
wfrun() { printf '{"conclusion":%s,"pull_requests":[{"number":%s}]}' "$1" "$2"; }

# t <expected> <label> <event> <ref> <pulls json> <workflow runs json> [extra env assignments...]
t() {
  local expected="$1" label="$2" event="$3" ref="$4" pulls="$5" wfruns="$6"; shift 6
  n=$((n + 1))
  local fake="$work/f$n"
  mkdir -p "$fake"
  printf '[%s]' "$pulls" > "$fake/pulls.json"
  echo '{"workflow_id":4242}' > "$fake/run.json"
  printf '{"workflow_runs":[%s]}' "$wfruns" > "$fake/wfruns.json"
  local got
  got="$(env "$@" FAKE="$fake" PATH="$work/bin:$PATH" GH_REPO=usezn/zn EVENT_NAME="$event" REF="$ref" SHA="$sha" RUN_ID=1 \
        DEDUPE_TRIES=2 DEDUPE_WAIT=0 bash "$script" 2>&1 | grep -E '^skip=' || true)"
  if [ "$got" = "skip=$expected" ]; then echo "ok   $label"; else echo "FAIL $label: expected skip=$expected, got [$got]"; fails=$((fails + 1)); fi
}

rel=refs/heads/release/1.15.0
good="$(pr 728 false "$sha" main usezn/zn)"
run_ok="$(wfrun '"success"' 728)"

t true  "push to a release branch with a ready pull request into main that has a live run skips" push $rel "$good" "$run_ok"
t true  "a run that is still going (no conclusion yet) counts" push $rel "$good" "$(wfrun null 728)"
t true  "a failed pull request run still covers the push" push $rel "$good" "$(wfrun '"failure"' 728)"
t true  "a pull request into another release branch counts" push $rel "$(pr 9 false "$sha" release/1.14.0 usezn/zn)" "$(wfrun null 9)"
t false "a pull request event is never skipped" pull_request $rel "$good" "$run_ok"
t false "a push to main is never skipped" push refs/heads/main "$good" "$run_ok"
t false "a push to next is never skipped" push refs/heads/next "$good" "$run_ok"
t false "a tag push is never skipped" push refs/tags/v1.15.0 "$good" "$run_ok"
t false "a scheduled run is never skipped" schedule $rel "$good" "$run_ok"
t false "no pull request means no skip" push $rel "" ""
t false "a draft pull request does not cover the push" push $rel "$(pr 728 true "$sha" main usezn/zn)" "$run_ok"
t false "a pull request into next only runs the sample" push $rel "$(pr 728 false "$sha" next usezn/zn)" "$run_ok"
t false "a pull request whose head is another commit does not cover it" push $rel "$(pr 728 false "$other" main usezn/zn)" "$run_ok"
t false "a pull request from a fork does not count" push $rel "$(pr 728 false "$sha" main someone/zn)" "$run_ok"
t false "no pull request run yet (merge conflict, paths filter) means no skip" push $rel "$good" ""
t false "a cancelled pull request run does not cover the push" push $rel "$good" "$(wfrun '"cancelled"' 728)"
t false "a skipped pull request run does not cover the push" push $rel "$good" "$(wfrun '"skipped"' 728)"
t false "a run of another pull request does not count" push $rel "$good" "$(wfrun '"success"' 99)"
t false "a cancelled run plus a live run of another pull request is no cover" push $rel "$good" "$(wfrun '"cancelled"' 728),$(wfrun null 99)"
t true  "a cancelled run plus a live run of the pull request skips" push $rel "$good" "$(wfrun '"cancelled"' 728),$(wfrun '"success"' 728)"

# API failures fail open: run the checks.
for kind in pulls run wfruns; do
  n=$((n + 1))
  fake="$work/f$n"; mkdir -p "$fake"
  printf '[%s]' "$good" > "$fake/pulls.json"; echo '{"workflow_id":4242}' > "$fake/run.json"
  printf '{"workflow_runs":[%s]}' "$run_ok" > "$fake/wfruns.json"; : > "$fake/fail-$kind"
  got="$(FAKE="$fake" PATH="$work/bin:$PATH" GH_REPO=usezn/zn EVENT_NAME=push REF=$rel SHA=$sha RUN_ID=1 DEDUPE_TRIES=2 DEDUPE_WAIT=0 \
        bash "$script" 2>&1 | grep -E '^skip=' || true)"
  if [ "$got" = "skip=false" ]; then echo "ok   a failing $kind call means no skip"; else echo "FAIL a failing $kind call: got [$got]"; fails=$((fails + 1)); fi
done

# Garbage from the API fails open too.
n=$((n + 1)); fake="$work/f$n"; mkdir -p "$fake"
echo 'not json' > "$fake/pulls.json"; echo '{"workflow_id":4242}' > "$fake/run.json"; echo '{}' > "$fake/wfruns.json"
got="$(FAKE="$fake" PATH="$work/bin:$PATH" GH_REPO=usezn/zn EVENT_NAME=push REF=$rel SHA=$sha RUN_ID=1 DEDUPE_TRIES=1 DEDUPE_WAIT=0 \
      bash "$script" 2>&1 | grep -E '^skip=' || true)"
if [ "$got" = "skip=false" ]; then echo "ok   an unreadable pull request list means no skip"; else echo "FAIL unreadable list: got [$got]"; fails=$((fails + 1)); fi

# The result also goes to $GITHUB_OUTPUT.
n=$((n + 1)); fake="$work/f$n"; mkdir -p "$fake"
printf '[%s]' "$good" > "$fake/pulls.json"; echo '{"workflow_id":4242}' > "$fake/run.json"; printf '{"workflow_runs":[%s]}' "$run_ok" > "$fake/wfruns.json"
FAKE="$fake" PATH="$work/bin:$PATH" GH_REPO=usezn/zn EVENT_NAME=push REF=$rel SHA=$sha RUN_ID=1 DEDUPE_TRIES=1 DEDUPE_WAIT=0 GITHUB_OUTPUT="$work/gho" \
  bash "$script" > /dev/null 2>&1
if [ "$(cat "$work/gho")" = "skip=true" ]; then echo "ok   the answer is written to GITHUB_OUTPUT"; else echo "FAIL GITHUB_OUTPUT: [$(cat "$work/gho")]"; fails=$((fails + 1)); fi

# No gh call at all outside release pushes.
n=$((n + 1)); fake="$work/f$n"; mkdir -p "$fake"; : > "$fake/calls.log"
FAKE="$fake" PATH="$work/bin:$PATH" GH_REPO=usezn/zn EVENT_NAME=push REF=refs/heads/main SHA=$sha RUN_ID=1 bash "$script" > /dev/null 2>&1
if [ ! -s "$fake/calls.log" ]; then echo "ok   a push to main makes no API call"; else echo "FAIL a push to main called the API"; fails=$((fails + 1)); fi

if [ "$fails" -gt 0 ]; then echo "$fails failed"; exit 1; fi
echo "all passed"
