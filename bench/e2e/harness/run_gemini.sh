#!/usr/bin/env bash
# End-to-end run of Gemini CLI with the zn hook against the scripted provider
# (Gemini API on 127.0.0.1, through GOOGLE_GEMINI_BASE_URL). Every value is fake.
#
#   bash run_gemini.sh <packages/zn-gate> <run dir> [gemini binary]
set -euo pipefail
PKG=$(cd "$1" && pwd)
RUN=$2
GEMINI=${3:-gemini}
H=$(cd "$(dirname "$0")" && pwd)
PORT=${PORT:-8790}
NODE=$(command -v node)

rm -rf "$RUN"; mkdir -p "$RUN"
node "$H/setup.js" --pkg "$PKG" --run "$RUN" --agent gemini >/dev/null
OUT=$RUN/out
mkdir -p "$RUN/bin" "$RUN/home/.gemini"
ln -sf "$PKG/bin/cli.js" "$RUN/bin/zn"
# Gemini CLI starts shell commands with a reduced environment, so ZN_HOME is not set for the agent: the vault
# lives in the default place under HOME, as it does for a real user.
export HOME=$RUN/home
export GEMINI_API_KEY=mock-provider-key GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:$PORT
export GEMINI_CLI_TRUST_WORKSPACE=true GEMINI_TELEMETRY_ENABLED=false NO_COLOR=1 CI=1
PATH=$RUN/bin:$(dirname "$NODE"):$(dirname "$GEMINI"):/usr/local/bin:/usr/bin:/bin
export PATH

ZN_HOME=$RUN/home/.zn node "$H/vault_daemon.js" --pkg "$PKG" --secrets "$RUN/secrets.json" --out "$OUT" & VPID=$!
node "$H/mock_llm.js" --port "$PORT" --script "$RUN/scenario.json" --out "$OUT" > "$OUT/mock.log" & MPID=$!
trap 'kill $VPID $MPID 2>/dev/null || true' EXIT
for _ in $(seq 50); do [ -f "$OUT/vault.ready" ] && break; sleep 0.2; done
[ -f "$OUT/vault.ready" ] || { cat "$OUT/vault.error"; exit 1; }

# Headless runs need an auth method in the settings; the base URL variable selects the "gateway" type.
printf '{"security":{"auth":{"selectedType":"%s"}}}
' "${GEMINI_E2E_AUTH:-gateway}" > "$HOME/.gemini/settings.json"
node -e "require('$PKG/lib/agents/gemini').install({ scope: 'user' })" > "$OUT/install.txt"
cp "$HOME/.gemini/settings.json" "$OUT/gemini_settings_after_install.json"

cd "$RUN/proj"
set +e
timeout 300 "$GEMINI" -m mock-model --approval-mode yolo -p "Follow the setup task." < /dev/null > "$OUT/gemini_stdout.txt" 2> "$OUT/gemini_stderr.txt"
echo "task exit=$?" > "$OUT/exit_codes.txt"
set -e
cp -r "$HOME/.gemini/tmp" "$OUT/transcripts" 2>/dev/null || true
echo "done"
