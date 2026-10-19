#!/usr/bin/env bash
# End-to-end run of OpenCode with the zn plugin against the scripted
# provider (OpenAI Chat Completions on 127.0.0.1). Every value is fake.
#
#   bash run_opencode.sh <packages/zn-gate> <run dir> [opencode binary]
set -euo pipefail
PKG=$(cd "$1" && pwd)
RUN=$2
OPENCODE=${3:-opencode}
H=$(cd "$(dirname "$0")" && pwd)
PORT=${PORT:-8789}
NODE=$(command -v node)

rm -rf "$RUN"; mkdir -p "$RUN"
node "$H/setup.js" --pkg "$PKG" --run "$RUN" --agent opencode >/dev/null
OUT=$RUN/out
export HOME=$RUN/home ZN_HOME=$RUN/zn XDG_CONFIG_HOME=$RUN/home/.config XDG_DATA_HOME=$RUN/home/.local/share XDG_STATE_HOME=$RUN/home/.local/state XDG_CACHE_HOME=$RUN/home/.cache
export MOCK_API_KEY=mock-provider-key OPENCODE_DISABLE_AUTOUPDATE=1 OPENCODE_DISABLE_SHARE=1
mkdir -p "$XDG_CONFIG_HOME/opencode"
cat > "$XDG_CONFIG_HOME/opencode/opencode.json" <<EOF
{
  "\$schema": "https://opencode.ai/config.json",
  "model": "mock/mock-model",
  "share": "disabled",
  "autoupdate": false,
  "permission": { "bash": "allow", "edit": "allow", "read": "allow", "webfetch": "deny", "external_directory": "allow" },
  "provider": {
    "mock": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "mock",
      "options": { "baseURL": "http://127.0.0.1:$PORT/v1", "apiKey": "{env:MOCK_API_KEY}" },
      "models": { "mock-model": { "name": "mock-model", "tool_call": true } }
    }
  }
}
EOF

node "$H/vault_daemon.js" --pkg "$PKG" --secrets "$RUN/secrets.json" --out "$OUT" & VPID=$!
node "$H/mock_llm.js" --port "$PORT" --script "$RUN/scenario.json" --out "$OUT" > "$OUT/mock.log" & MPID=$!
trap 'kill $VPID $MPID 2>/dev/null || true' EXIT
for i in $(seq 50); do [ -f "$OUT/vault.ready" ] && break; sleep 0.2; done
[ -f "$OUT/vault.ready" ] || { cat "$OUT/vault.error"; exit 1; }

node -e "require('$PKG/lib/agents/opencode').install({ scope: 'user', mcp: false })" >/dev/null

cd "$RUN/proj"
set +e
timeout 300 "$OPENCODE" run --print-logs "Follow the setup task." < /dev/null > "$OUT/opencode_stdout.txt" 2> "$OUT/opencode_stderr.txt"
echo "task exit=$?" > "$OUT/exit_codes.txt"
timeout 120 "$OPENCODE" run "$(cat "$RUN/pasted.txt")" < /dev/null > "$OUT/opencode_paste_stdout.txt" 2> "$OUT/opencode_paste_stderr.txt"
echo "paste exit=$?" >> "$OUT/exit_codes.txt"
set -e
cp -r "$XDG_DATA_HOME/opencode/storage" "$OUT/transcripts" 2>/dev/null || true
echo done
