#!/usr/bin/env bash
# Entry of the znops job: GitHub Copilot CLI end-to-end on an ephemeral Ubuntu VM.
# Staged inputs (cwd): src.tgz (the repo working tree), versions.env.
set -uo pipefail
IN=$(pwd)
RES=${ZN_OUT:?ZN_OUT not set}
W=/w
mkdir -p "$W/dl" "$RES"
exec > >(tee -a "$RES/boot.log") 2>&1
set -x
export DEBIAN_FRONTEND=noninteractive
KIT_PYTHONPATH=${PYTHONPATH:-}
unset PYTHONPATH
kit_fail() { PYTHONPATH=$KIT_PYTHONPATH python3 -m znops.markers fail "$1" || true; }
# shellcheck disable=SC1091
. "$IN/versions.env"
NODE24=v24.21.0
NODE24_SHA=fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6

# shellcheck disable=SC2015
apt-get -o DPkg::Lock::Timeout=300 update -q && apt-get -o DPkg::Lock::Timeout=300 install -y -q git xz-utils jq ca-certificates curl python3 || { kit_fail "abort: APT"; exit 1; }
f=$W/dl/node.tar.xz
# shellcheck disable=SC2015
curl -fsSLo "$f" "https://nodejs.org/dist/$NODE24/node-$NODE24-linux-x64.tar.xz" && echo "$NODE24_SHA  $f" | sha256sum -c - && tar -xJf "$f" -C /opt || { kit_fail "abort: NODE"; exit 1; }
export PATH=/opt/node-$NODE24-linux-x64/bin:$PATH
# shellcheck disable=SC2015
mkdir -p /w/src && tar -xzf "$IN/src.tgz" -C /w/src || { kit_fail "abort: SRC"; exit 1; }
npm install -g --prefix /w/agents "@github/copilot${ZN_COPILOT_VERSION:+@$ZN_COPILOT_VERSION}" || { kit_fail "abort: COPILOT"; exit 1; }
COP=/w/agents/bin/copilot
"$COP" --version | tee "$RES/copilot_version.txt"
"$COP" --help > "$RES/copilot_help.txt" 2>&1 || true

cd /w/src || exit 1
(cd packages/zn-gate && npm ci --ignore-scripts --omit=dev) || { kit_fail "abort: NPM_CI"; exit 1; }
bash bench/e2e/harness/run_copilot.sh packages/zn-gate /w/run "$COP" > "$RES/run.log" 2>&1
echo "run rc=$?" >> "$RES/run.log"
R=/w/run
FAIL=0
node bench/e2e/harness/summarize_openai.js "$R" > "$RES/summary.txt" || FAIL=1
node bench/e2e/harness/check_leaks.js --values "$R/values.json" --label sent "$R/out/requests.jsonl" --label local "$R/out/transcripts" "$R/out/copilot_stdout.txt" "$R/out/copilot_stderr.txt" > "$RES/leak-check.raw" 2>&1 || FAIL=1
sed "s#$R#<run>#g" "$RES/leak-check.raw" > "$RES/leak-check.txt"; rm -f "$RES/leak-check.raw"
cp -r "$R/out" "$RES/out" 2>/dev/null || true
cp "$R/scenario.json" "$RES/" 2>/dev/null || true
echo "{\"result\": \"$([ $FAIL = 0 ] && echo PASS || echo FAIL)\"}" > "$RES/summary.json"
[ $FAIL = 0 ] || { kit_fail "copilot e2e FAIL"; exit 1; }
exit 0
