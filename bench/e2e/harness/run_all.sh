#!/usr/bin/env bash
# Runs the end-to-end scenario on every agent CLI found and writes the
# redacted evidence to bench/e2e/<agent>/:
#   summary.txt        each tool call and the result the model got (fake values replaced by names)
#   leak-check.txt     fake values found in what was sent to the provider (must be 0) and in local files
#   confirmations.jsonl  what the vault asked the user out of band, and the answer
#   exit-codes.txt
#
#   bash bench/e2e/harness/run_all.sh <work dir> [bin dir with claude/codex/opencode]
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
PKG=$ROOT/packages/zn-gate
WORK=$1
BIN=${2:-}
H=$ROOT/bench/e2e/harness
EV=$ROOT/bench/e2e
find_bin() { if [ -n "$BIN" ] && [ -x "$BIN/$1" ]; then echo "$BIN/$1"; else command -v "$1" || true; fi; }

evidence() { # agent run-dir summarizer sent-files... -- local-files...
  local agent=$1 run=$2 summ=$3; shift 3
  local dir=$EV/$agent; mkdir -p "$dir"
  node "$H/$summ" "$run" > "$dir/summary.txt"
  local sent=() local_=() mode=sent
  for a in "$@"; do if [ "$a" = -- ]; then mode=local; elif [ $mode = sent ]; then sent+=("$a"); else local_+=("$a"); fi; done
  node "$H/check_leaks.js" --values "$run/values.json" --label sent "${sent[@]}" --label local "${local_[@]}" | sed "s#$run#<run>#g" > "$dir/leak-check.txt"
  cp "$run/out/confirmations.jsonl" "$dir/confirmations.jsonl" 2>/dev/null || true
  cp "$run/out/exit_codes.txt" "$dir/exit-codes.txt" 2>/dev/null || true
  { echo "date: $(date -u +%Y-%m-%dT%H:%MZ)"; echo "host: $(uname -sr), node $(node -v)"; } > "$dir/run.txt"
}

C=$(find_bin claude)
if [ -n "$C" ]; then
  bash "$H/run_claude.sh" "$PKG" "$WORK/claude" "$C" >/dev/null
  R=$WORK/claude
  evidence claude-code "$R" summarize_claude.js "$R/out/requests.jsonl" -- "$R/out/transcripts" "$R/out/claude_stream.jsonl" "$R/out/claude_paste_stream.jsonl"
  echo "agent version: $("$C" --version)" >> "$EV/claude-code/run.txt"
  # What the user saw in the permission dialogs (the approver logged it), redacted.
  node -e '
    const fs=require("fs");const [vf,lf]=process.argv.slice(1);const vals=JSON.parse(fs.readFileSync(vf,"utf8"));
    let t=fs.readFileSync(lf,"utf8");for(const v of vals)t=t.split(v.value).join("<<VALUE:"+v.name+">>");process.stdout.write(t.split(process.argv[3]).join("<run>"));
  ' "$R/values.json" "$R/out/permission_prompts.jsonl" "$R" > "$EV/claude-code/permission-prompts.redacted.jsonl"
fi

X=$(find_bin codex)
if [ -n "$X" ]; then
  bash "$H/run_codex.sh" "$PKG" "$WORK/codex" "$X" >/dev/null
  R=$WORK/codex
  evidence codex "$R" summarize_openai.js "$R/out/requests.jsonl" -- "$R/out/transcripts" "$R/out/codex_events.jsonl" "$R/out/codex_paste_events.jsonl"
  echo "agent version: $("$X" --version)" >> "$EV/codex/run.txt"
fi

O=$(find_bin opencode)
if [ -n "$O" ]; then
  bash "$H/run_opencode.sh" "$PKG" "$WORK/opencode" "$O" >/dev/null
  R=$WORK/opencode
  evidence opencode "$R" summarize_openai.js "$R/out/requests.jsonl" -- "$R/home/.local/share/opencode" "$R/out/opencode_stdout.txt" "$R/out/opencode_stderr.txt"
  echo "agent version: $("$O" --version)" >> "$EV/opencode/run.txt"
fi
cat "$EV"/*/leak-check.txt
# Paths of this checkout are not evidence.
sed -i "s#$ROOT#<repo>#g" "$EV"/*/*.txt "$EV"/*/*.jsonl 2>/dev/null || true
