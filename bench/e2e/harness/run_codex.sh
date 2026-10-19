#!/usr/bin/env bash
# End-to-end run of the Codex CLI with the zn hooks against the scripted
# provider (OpenAI Responses API on 127.0.0.1). Every value is fake.
#
#   bash run_codex.sh <packages/zn-gate> <run dir> [codex binary] [sandbox]
#
# sandbox: "bypass" (default: --dangerously-bypass-approvals-and-sandbox) or
# a Codex sandbox mode such as workspace-write. Hooks are trusted for the run
# with --dangerously-bypass-hook-trust (what /hooks would record).
set -euo pipefail
PKG=$(cd "$1" && pwd)
RUN=$2
CODEX=${3:-codex}
SANDBOX=${4:-bypass}
H=$(cd "$(dirname "$0")" && pwd)
PORT=${PORT:-8788}
NODE=$(command -v node)

rm -rf "$RUN"; mkdir -p "$RUN"
node "$H/setup.js" --pkg "$PKG" --run "$RUN" --agent codex >/dev/null
OUT=$RUN/out
mkdir -p "$RUN/bin" "$RUN/home/.codex"
ln -sf "$PKG/bin/cli.js" "$RUN/bin/zn"
export HOME=$RUN/home ZN_HOME=$RUN/zn CODEX_HOME=$RUN/home/.codex MOCK_API_KEY=mock-provider-key
export PATH=$RUN/bin:$(dirname "$NODE"):/usr/local/bin:/usr/bin:/bin
cat > "$CODEX_HOME/config.toml" <<EOF
model = "mock-model"
model_provider = "mock"
[model_providers.mock]
name = "mock"
base_url = "http://127.0.0.1:$PORT/v1"
env_key = "MOCK_API_KEY"
wire_api = "responses"
EOF

node "$H/vault_daemon.js" --pkg "$PKG" --secrets "$RUN/secrets.json" --out "$OUT" & VPID=$!
node "$H/mock_llm.js" --port "$PORT" --script "$RUN/scenario.json" --out "$OUT" > "$OUT/mock.log" & MPID=$!
trap 'kill $VPID $MPID 2>/dev/null || true' EXIT
for i in $(seq 50); do [ -f "$OUT/vault.ready" ] && break; sleep 0.2; done
[ -f "$OUT/vault.ready" ] || { cat "$OUT/vault.error"; exit 1; }

node -e "require('$PKG/lib/agents/codex').install({ scope: 'user', mcp: false })" >/dev/null
if [ "$SANDBOX" = bypass ]; then SB=(--dangerously-bypass-approvals-and-sandbox); else SB=(-s "$SANDBOX"); fi

cd "$RUN/proj"
set +e
"$CODEX" exec --skip-git-repo-check --dangerously-bypass-hook-trust "${SB[@]}" --json "Follow the setup task." < /dev/null > "$OUT/codex_events.jsonl" 2> "$OUT/codex_stderr.txt"
echo "task exit=$?" > "$OUT/exit_codes.txt"
"$CODEX" exec --skip-git-repo-check --dangerously-bypass-hook-trust "${SB[@]}" --json "$(cat "$RUN/pasted.txt")" < /dev/null > "$OUT/codex_paste_events.jsonl" 2> "$OUT/codex_paste_stderr.txt"
echo "paste exit=$?" >> "$OUT/exit_codes.txt"
set -e
cp -r "$CODEX_HOME/sessions" "$OUT/transcripts" 2>/dev/null || true
echo done
