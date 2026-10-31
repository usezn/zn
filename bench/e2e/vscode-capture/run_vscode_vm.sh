#!/usr/bin/env bash
# znops job entry: capture real VS Code agent-hook payloads on an ephemeral Ubuntu VM.
# Stage 1 (this script): install the official VS Code .deb, set up an audit workspace, then start the GitHub device-code
# sign-in of `code tunnel` and STOP there. The sign-in needs a person with a GitHub account that has Copilot to approve it;
# no password or token is ever handled here. Stage 2 (drive_prompts.sh, run after Copilot is signed in) sends the
# prompts in drive_prompts.txt through `code chat --mode agent`. Staged inputs (cwd): audit_hook.sh, hooks-*.json, drive_prompts.txt.
# shellcheck disable=SC2015
set -uo pipefail
IN=$(pwd)
RES=${ZN_OUT:?ZN_OUT not set}
W=/w
mkdir -p "$W/ws/.github/hooks" "$W/ws/notes" "$RES"
exec > >(tee -a "$RES/boot.log") 2>&1
export DEBIAN_FRONTEND=noninteractive
apt-get -o DPkg::Lock::Timeout=300 update -q && apt-get -o DPkg::Lock::Timeout=300 install -y -q xvfb curl ca-certificates jq libnss3 libgbm1 libasound2t64 libgtk-3-0 libxkbfile1 libsecret-1-0 || { echo "abort: APT"; exit 1; }
curl -fsSLo "$W/code.deb" "https://code.visualstudio.com/sha/download?build=stable&os=linux-deb-x64" || { echo "abort: DOWNLOAD"; exit 1; }
dpkg -i "$W/code.deb" || apt-get -f install -y -q || { echo "abort: DPKG"; exit 1; }
code --version | tee "$RES/code_version.txt"
cp "$IN/audit_hook.sh" "$W/ws/.github/hooks/"
# One spelling per run, chosen by ZN_HOOK_SPELLING=camelcase|pascalcase (default camelcase); both files are kept in $RES.
SP=${ZN_HOOK_SPELLING:-camelcase}
cp "$IN/hooks-$SP.json" "$W/ws/.github/hooks/audit.json"
echo "# capture workspace" > "$W/ws/README.md"
cp "$IN/drive_prompts.txt" "$W/"
export ZN_CAPTURE_DIR="$RES/captured"
mkdir -p "$ZN_CAPTURE_DIR"
# Sign-in step: GitHub device code (https://github.com/login/device). Print it for the orchestrator and wait up to 15 min.
nohup xvfb-run -a code tunnel --accept-server-license-terms --name zn-cap > "$RES/tunnel.log" 2>&1 &
for _ in $(seq 1 90); do
  grep -q -E "[A-Z0-9]{4}-[A-Z0-9]{4}" "$RES/tunnel.log" 2>/dev/null && break
  sleep 2
done
grep -E "github.com/login/device|[A-Z0-9]{4}-[A-Z0-9]{4}" "$RES/tunnel.log" > "$RES/LOGIN_PROMPT.txt" || true
echo "NEEDS_APPROVAL: device-code sign-in printed in LOGIN_PROMPT.txt; Copilot sign-in inside the tunnel's VS Code is the next manual step" > "$RES/STATE.txt"
for _ in $(seq 1 450); do
  grep -q -i "open this link\|Open this link in your browser https://vscode.dev/tunnel" "$RES/tunnel.log" && break
  sleep 2
done
echo "kit stopped at the sign-in step (stage 2 not run)" >> "$RES/STATE.txt"
exit 0
