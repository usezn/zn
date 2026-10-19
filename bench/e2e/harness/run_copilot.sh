#!/usr/bin/env bash
# End-to-end run of GitHub Copilot CLI with the zn hooks against the scripted provider
# (OpenAI Chat Completions on 127.0.0.1, through Copilot's own-model settings). Every value is fake.
#
#   bash run_copilot.sh <packages/zn-gate> <run dir> [copilot binary]
set -euo pipefail
PKG=$(cd "$1" && pwd)
RUN=$2
COPILOT=${3:-copilot}
H=$(cd "$(dirname "$0")" && pwd)
PORT=${PORT:-8791}
NODE=$(command -v node)

rm -rf "$RUN"; mkdir -p "$RUN"
node "$H/setup.js" --pkg "$PKG" --run "$RUN" --agent copilot >/dev/null
OUT=$RUN/out
mkdir -p "$RUN/bin" "$RUN/home/.copilot"
ln -sf "$PKG/bin/cli.js" "$RUN/bin/zn"
export HOME=$RUN/home COPILOT_HOME=$RUN/home/.copilot
export COPILOT_PROVIDER_BASE_URL=http://127.0.0.1:$PORT/v1 COPILOT_PROVIDER_TYPE=openai COPILOT_PROVIDER_API_KEY=mock-provider-key
export COPILOT_MODEL=mock-model COPILOT_OFFLINE=true NO_COLOR=1 CI=1
export PATH=$RUN/bin:$(dirname "$NODE"):$(dirname "$COPILOT"):/usr/local/bin:/usr/bin:/bin

ZN_HOME=$RUN/home/.zn node "$H/vault_daemon.js" --pkg "$PKG" --secrets "$RUN/secrets.json" --out "$OUT" & VPID=$!
node "$H/mock_llm.js" --port "$PORT" --script "$RUN/scenario.json" --out "$OUT" > "$OUT/mock.log" & MPID=$!
trap 'kill $VPID $MPID 2>/dev/null || true' EXIT
for i in $(seq 50); do [ -f "$OUT/vault.ready" ] && break; sleep 0.2; done
[ -f "$OUT/vault.ready" ] || { cat "$OUT/vault.error"; exit 1; }

node -e "require('$PKG/lib/agents/copilot').install({ scope: 'user', env: process.env })" > "$OUT/install.txt"
cp "$COPILOT_HOME/hooks/zn-gate.json" "$OUT/copilot_hooks_after_install.json"

cd "$RUN/proj"
set +e
timeout 300 "$COPILOT" -p "Follow the setup task." --allow-all-tools --allow-all-paths --no-ask-user --log-level debug --log-dir "$OUT/copilot_logs" < /dev/null > "$OUT/copilot_stdout.txt" 2> "$OUT/copilot_stderr.txt"
echo "task exit=$?" > "$OUT/exit_codes.txt"
set -e
cp -r "$COPILOT_HOME" "$OUT/transcripts" 2>/dev/null || true
echo done
