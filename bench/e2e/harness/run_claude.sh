#!/usr/bin/env bash
# End-to-end run of Claude Code with the zn hooks against the scripted
# provider. Nothing leaves the machine: the provider is mock_llm.js on
# 127.0.0.1 and every value is fake.
#
#   bash run_claude.sh <packages/zn-gate> <run dir> [claude binary]
set -euo pipefail
PKG=$(cd "$1" && pwd)
RUN=$2
CLAUDE=${3:-claude}
H=$(cd "$(dirname "$0")" && pwd)
PORT=${PORT:-8787}

rm -rf "$RUN"; mkdir -p "$RUN"
node "$H/setup.js" --pkg "$PKG" --run "$RUN" --agent claude-code >/dev/null
OUT=$RUN/out
export HOME=$RUN/home ZN_HOME=$RUN/zn CLAUDE_CONFIG_DIR=$RUN/home/.claude
export ANTHROPIC_BASE_URL=http://127.0.0.1:$PORT ANTHROPIC_API_KEY=mock-provider-key
export DISABLE_TELEMETRY=1 DISABLE_AUTOUPDATER=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_ERROR_REPORTING=1
export APPROVER_LOG=$OUT/permission_prompts.jsonl

node "$H/vault_daemon.js" --pkg "$PKG" --secrets "$RUN/secrets.json" --out "$OUT" & VPID=$!
node "$H/mock_llm.js" --port "$PORT" --script "$RUN/scenario.json" --out "$OUT" > "$OUT/mock.log" & MPID=$!
trap 'kill $VPID $MPID 2>/dev/null || true' EXIT
for i in $(seq 50); do [ -f "$OUT/vault.ready" ] && break; sleep 0.2; done
[ -f "$OUT/vault.ready" ] || { cat "$OUT/vault.error"; exit 1; }

node -e "require('$PKG/lib/agents/claude-code').install({ scope: 'user', mcp: false })" >/dev/null
cat > "$RUN/mcp.json" <<EOF
{ "mcpServers": { "approver": { "type": "stdio", "command": "$(command -v node)", "args": ["$H/approver_mcp.js"] } } }
EOF

cd "$RUN/proj"
set +e
"$CLAUDE" -p "Follow the setup task." --mcp-config "$RUN/mcp.json" --permission-prompt-tool mcp__approver__approve \
  --output-format stream-json --verbose > "$OUT/claude_stream.jsonl" 2> "$OUT/claude_stderr.txt"
echo "task exit=$?" > "$OUT/exit_codes.txt"
# A prompt with a pasted secret: the hook must stop it before any request.
"$CLAUDE" -p "$(cat "$RUN/pasted.txt")" --output-format stream-json --verbose > "$OUT/claude_paste_stream.jsonl" 2> "$OUT/claude_paste_stderr.txt"
echo "paste exit=$?" >> "$OUT/exit_codes.txt"
set -e
cp -r "$CLAUDE_CONFIG_DIR/projects" "$OUT/transcripts" 2>/dev/null || true
git -C "$RUN/proj" status --short > "$OUT/git_status.txt" || true
cp "$RUN/proj/src/client.js" "$OUT/client.js" 2>/dev/null || true
echo done
