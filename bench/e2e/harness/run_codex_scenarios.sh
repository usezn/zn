#!/usr/bin/env bash
# Hook scenarios for the Codex CLI against the scripted provider on 127.0.0.1
# (no account, no key; every value is fake). One case per scenario:
#
#   permission  PermissionRequest, with approvals on (no bypass), in the terminal UI
#               through a pseudo-terminal (codex exec never asks for approval): zn denies a
#               marker command and gives no answer for an ordinary one, which is declined
#   mcp         an MCP tool call through PreToolUse: a placeholder and a secret
#               value are denied, a plain call reaches the server
#   stop-warn   Stop with a secret value in the final answer: a warning only
#   stop-block  Stop with "stopReview": "block": Codex continues once
#   stop-placeholder  Stop with a placeholder no tool produced (observation)
#   replace     PostToolUse with "replaceToolOutputOnSecret": continue false
#               and a stop reason; the model never gets the value
#   session-context  SessionStart and SubagentStart: the reminder reaches the model, and whether a
#               subagent's own tool calls go through zn's hooks (observation)
#   thirdparty  another tool's PreToolUse hook answers allow + updatedInput:
#               zn's PreToolUse sees the original command, the rewritten one
#               runs, and PostToolUse withholds the output of the command
#               that really ran
#
#   bash run_codex_scenarios.sh <work dir> [codex binary] [scenario ...]
#
# Evidence goes to bench/e2e/codex/scenarios/<scenario>/ (or $EVIDENCE_DIR):
#   summary.txt     each tool call and the result the model got
#   leak-check.txt  fake values (and encodings) in what was sent to the provider; must be 0
#   hooks.txt       every hook call and what zn answered
#   checks.txt      PASS / FAIL per check
#   exit-codes.txt, confirmations.jsonl, run.txt (same names and formats as the other
#   cases of run_all.sh, so that a check against committed evidence can read them)
# Exit code 1 if any check fails or any value reached the provider.
set -uo pipefail
H=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$H/../../.." && pwd)
PKG=$ROOT/packages/zn-gate
WORK=$(mkdir -p "$1" && cd "$1" && pwd)
CODEX=${2:-codex}
[ $# -ge 2 ] && shift 2 || shift $#
SCENARIOS=("$@")
[ ${#SCENARIOS[@]} -eq 0 ] && SCENARIOS=(permission mcp stop-warn stop-block stop-placeholder replace thirdparty session-context)
EVIDENCE=${EVIDENCE_DIR:-$ROOT/bench/e2e/codex/scenarios}
NODE=$(command -v node)
BASEPORT=${BASEPORT:-8800}
STATUS=0

run_one() {
  local S=$1 PORT=$2
  local RUN=$WORK/$S OUT=$WORK/$S/out
  rm -rf "$RUN"; mkdir -p "$RUN"
  node "$H/setup.js" --pkg "$PKG" --run "$RUN" --agent codex --scenario "$S" >/dev/null || return 1
  mkdir -p "$RUN/bin" "$RUN/home/.codex" "$RUN/home/.zn"
  ln -sf "$PKG/bin/cli.js" "$RUN/bin/zn"
  (
    export HOME=$RUN/home ZN_HOME=$RUN/zn CODEX_HOME=$RUN/home/.codex MOCK_API_KEY=mock-provider-key
    export PATH=$RUN/bin:$(dirname "$NODE"):/usr/local/bin:/usr/bin:/bin
    {
      echo 'model = "mock-model"'
      echo 'model_provider = "mock"'
      echo '[model_providers.mock]'
      echo 'name = "mock"'
      echo "base_url = \"http://127.0.0.1:$PORT/v1\""
      echo 'env_key = "MOCK_API_KEY"'
      echo 'wire_api = "responses"'
      if [ "$S" = permission ]; then
        echo 'check_for_update_on_startup = false'
        echo "[projects.\"$RUN/proj\"]"
        echo 'trust_level = "trusted"'
      fi
      if [ "$S" = session-context ]; then
        # Codex versions differ in how the subagent tools are offered; CODEX_FEATURES_TOML adds lines such as: multi_agent = true
        echo '[features]'
        printf '%s\n' "${CODEX_FEATURES_TOML:-multi_agent = true}"
      fi
      if [ "$S" = mcp ]; then
        echo '[mcp_servers.echo]'
        echo "command = \"$NODE\""
        echo "args = [\"$H/echo_mcp.js\", \"$OUT/echo_mcp.jsonl\"]"
      fi
    } > "$CODEX_HOME/config.toml"
    case $S in
      stop-block|stop-placeholder) echo '{"hooks": {"stopReview": "block"}}' > "$HOME/.zn/config.json" ;;
      replace) echo '{"hooks": {"replaceToolOutputOnSecret": true}}' > "$HOME/.zn/config.json" ;;
    esac

    node "$H/vault_daemon.js" --pkg "$PKG" --secrets "$RUN/secrets.json" --out "$OUT" & VPID=$!
    node "$H/mock_llm.js" --port "$PORT" --script "$RUN/scenario.json" --out "$OUT" > "$OUT/mock.log" & MPID=$!
    trap 'kill $VPID $MPID 2>/dev/null || true' EXIT
    for _ in $(seq 50); do [ -f "$OUT/vault.ready" ] && break; sleep 0.2; done
    [ -f "$OUT/vault.ready" ] || { cat "$OUT/vault.error"; exit 1; }

    node -e "require('$PKG/lib/agents/codex').install({ scope: 'user', mcp: false })" >/dev/null
    node "$H/wrap_hooks.js" "$CODEX_HOME/hooks.json" "$H/spy_hook.js" "$S" "$H/third_party_hook.js" "$OUT/third_party.jsonl" "$OUT/hook_spy.jsonl" || exit 1

    if [ "$S" = permission ]; then
      # Approvals stay on: a call that asks to leave the sandbox runs only if the user approves it.
      FLAGS=(-c 'approval_policy="on-request"' -s read-only)
    else
      FLAGS=(--dangerously-bypass-approvals-and-sandbox)
    fi
    cd "$RUN/proj"
    if [ "$S" = permission ]; then
      # codex exec never asks for approval (its policy is fixed to "never"), so PermissionRequest
      # cannot run there: the terminal UI is driven through a pseudo-terminal instead.
      python3 "$H/tui_permission.py" "$CODEX" "$RUN/proj" "$OUT" < /dev/null > "$OUT/tui_driver.txt" 2>&1
    else
      "$CODEX" exec --skip-git-repo-check --dangerously-bypass-hook-trust "${FLAGS[@]}" --json "Follow the setup task." < /dev/null > "$OUT/codex_events.jsonl" 2> "$OUT/codex_stderr.txt"
    fi
    echo "task exit=$?" > "$OUT/exit_codes.txt"
    cp -r "$CODEX_HOME/sessions" "$OUT/transcripts" 2>/dev/null || true
    cat "$OUT"/transcripts/*/*/*/*.jsonl 2>/dev/null | grep -o "__ZN_GITHUB_TOKEN__" | wc -l > "$OUT/transcripts_count.txt"
  )
  local rc=0
  node "$H/check_codex_scenario.js" "$S" "$RUN" || rc=1
  local D=$EVIDENCE/$S; mkdir -p "$D"
  node "$H/summarize_openai.js" "$RUN" > "$D/summary.txt"
  node "$H/check_leaks.js" --values "$RUN/values.json" --label sent "$OUT/requests.jsonl" --label local "$OUT/transcripts" "$OUT/codex_events.jsonl" | sed "s#$RUN#<run>#g" > "$D/leak-check.txt" || rc=1
  cp "$OUT/confirmations.jsonl" "$D/confirmations.jsonl" 2>/dev/null || true
  { echo "date: $(date -u +%Y-%m-%dT%H:%MZ)"; echo "host: $(uname -sr), node $(node -v)"; echo "agent version: $("$CODEX" --version)"; } > "$D/run.txt"
  cp "$OUT/hooks.txt" "$D/hooks.txt"; cp "$OUT/checks.txt" "$D/checks.txt"; cp "$OUT/exit_codes.txt" "$D/exit-codes.txt" 2>/dev/null || true
  # The value the scripted model writes itself (mcp-values.json) is not in values.json: name it in the evidence too.
  node -e 'const fs=require("fs");const v=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));for(const f of process.argv.slice(2)){let t=fs.readFileSync(f,"utf8");for(const x of v)t=t.split(x.value).join("<<VALUE:"+x.name+">>");fs.writeFileSync(f,t)}' "$RUN/mcp-values.json" "$D"/*.txt
  echo "== $S: $([ $rc = 0 ] && echo OK || echo FAILED)"; cat "$D/leak-check.txt"
  return $rc
}

i=0
for S in "${SCENARIOS[@]}"; do
  run_one "$S" $((BASEPORT + i)) || STATUS=1
  i=$((i + 1))
done
mkdir -p "$EVIDENCE"
{ echo "date: $(date -u +%Y-%m-%dT%H:%MZ)"; echo "host: $(uname -sr), node $(node -v)"; echo "agent version: $("$CODEX" --version)"; } > "$EVIDENCE/run.txt"
sed -i "s#$ROOT#<repo>#g" "$EVIDENCE"/*/*.txt 2>/dev/null || true
exit $STATUS
