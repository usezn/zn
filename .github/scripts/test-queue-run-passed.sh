#!/usr/bin/env bash
# Tests .github/scripts/queue-run-passed.sh with a fake gh (no network).
# Run from anywhere inside the repository: bash .github/scripts/test-queue-run-passed.sh
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
script="$root/.github/scripts/queue-run-passed.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin"
fails=0
sha="0123456789abcdef0123456789abcdef01234567"
wf=".github/workflows/scrubber.yml"
jobname="scrubber + vault (node 22 / ubuntu-latest)"

# The fake gh answers from $RUNS_JSON, $JOBS_JSON, or fails when GH_FAIL=1.
cat > "$work/bin/gh" <<'GH'
#!/usr/bin/env bash
[ "${GH_FAIL:-0}" = "1" ] && exit 1
case "$2" in
  *"/actions/runs?"*) printf '%s' "$RUNS_JSON" ;;
  *"/jobs?"*) printf '%s' "$JOBS_JSON" ;;
  *) exit 1 ;;
esac
GH
chmod +x "$work/bin/gh"

run_json() { # <conclusion> <status> <branch> <path>
  printf '{"workflow_runs":[{"id":7,"path":"%s","status":"%s","conclusion":"%s","head_sha":"%s","head_branch":"%s"}]}' "$4" "$2" "$1" "$sha" "$3"
}
jobs_json() { printf '{"jobs":[{"name":"%s","conclusion":"%s"}]}' "$jobname" "$1"; }

# check <expected> <label> [VAR=value ...]
check() {
  local expected="$1" label="$2"; shift 2
  local got
  got="$(env PATH="$work/bin:$PATH" EVENT_NAME=push REF=refs/heads/next SHA="$sha" REPO=usezn/zn WORKFLOW_PATH="$wf" \
    REPEATED_JOBS="$jobname" GITHUB_OUTPUT= RUNS_JSON="$(run_json success completed gh-readonly-queue/next/pr-1-abc "$wf")" \
    JOBS_JSON="$(jobs_json success)" "$@" bash "$script" 2>/dev/null | grep -E '^already_passed=' || true)"
  if [ "$got" = "already_passed=$expected" ]; then echo "ok   $label"; else echo "FAIL $label: expected $expected, got '$got'"; fails=$((fails + 1)); fi
}

check true  "queue run and job both passed"
check true  "path with a ref suffix still matches" RUNS_JSON="$(run_json success completed gh-readonly-queue/next/pr-1-abc "$wf@refs/heads/next")"
check false "pull request event" EVENT_NAME=pull_request
check false "push to main" REF=refs/heads/main
check false "malformed sha" SHA=nope
check false "gh fails" GH_FAIL=1
check false "queue run still going" RUNS_JSON="$(run_json "" in_progress gh-readonly-queue/next/pr-1-abc "$wf")"
check false "queue run failed" RUNS_JSON="$(run_json failure completed gh-readonly-queue/next/pr-1-abc "$wf")"
check false "queue run cancelled" RUNS_JSON="$(run_json cancelled completed gh-readonly-queue/next/pr-1-abc "$wf")"
check false "run of another branch" RUNS_JSON="$(run_json success completed feature/x "$wf")"
check false "run of another workflow" RUNS_JSON="$(run_json success completed gh-readonly-queue/next/pr-1-abc .github/workflows/other.yml)"
check false "run list is not JSON" RUNS_JSON="not json"
check false "required job failed in the run" JOBS_JSON="$(jobs_json failure)"
check false "required job missing in the run" JOBS_JSON='{"jobs":[]}'
check false "no jobs to compare" REPEATED_JOBS=
check false "bad workflow path" WORKFLOW_PATH='../x.yml'

if [ "$fails" -ne 0 ]; then echo "$fails failed"; exit 1; fi
echo "all passed"
