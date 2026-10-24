#!/bin/bash
# Entry of the znops job: Antigravity CLI (agy) end-to-end on an ephemeral Ubuntu 24.04 VM.
# Staged inputs (cwd = /opt/znjob/work):
#   params.env              MODE, TGZ, SHA, GCP_PROJECT, GCP_LOCATIONS, AGY_MODEL, AGY_FLAGS
#   zn-gate-<version>.tgz   the zn-gate tree under test, packed with npm pack
#   fake_secrets.js         the fake-secret generator of that same tree
#   kit/                    bench/e2e/harness/{run_antigravity.sh, agy_spy.sh, check_antigravity_scenario.js,
#                           check_leaks.js, setup_antigravity.js}
# MODE:
#   smoke      no credential: install agy and zn-gate, record `agy --version`, --help and the auth options,
#              and check that a prompt without authentication fails.
#   preflight  smoke + ONE minimal request authenticated with the VM's own identity (AGY_ADC_AUTH=true, Vertex AI).
#   full       preflight, then every scenario of run_antigravity.sh.
#   selftest   no agy at all: the kit against mock_agy.js, to test the kit's own scripts (no account, no model).
# Results go to $ZN_OUT: summary.json {"result": PASS|FAIL|INCONCLUSIVE|BLOCKED|SMOKE_OK|PREFLIGHT_OK}, versions,
# logs, evidence/. Only fake values. No key is created or stored: the credential is the metadata-server identity of
# the VM.
# shellcheck disable=SC2030,SC2031 # each agy call runs in a subshell with its own HOME and account settings, on purpose
# shellcheck disable=SC2015,SC1091 # "A && B || C" is used as try-or-abort; os-release is only read for its name
set -euo pipefail

: "${ZN_OUT:?ZN_OUT is not set (run through znops.gcp_vm)}"
mkdir -p "$ZN_OUT/_status"
ZN_RC_FILE="${ZN_RC_FILE:-$ZN_OUT/_status/rc}"
scrub_key() { # remove the key file and any output file that holds the key value
  if [ -n "${KEYFILE:-}" ] && [ -s "$KEYFILE" ]; then
    grep -rlF -f "$KEYFILE" "$ZN_OUT" 2> /dev/null | while read -r hit; do echo "removed $hit (held the key)" >> "$ZN_OUT/SCRUB.txt"; rm -f "$hit"; done
    if grep -rqF -f "$KEYFILE" "$ZN_OUT" 2> /dev/null; then echo "KEY STILL PRESENT IN OUTPUTS" >> "$ZN_OUT/SCRUB.txt"; fi
    shred -u "$KEYFILE" 2> /dev/null || rm -f "$KEYFILE"
  fi
}
on_exit() {
  local rc=$?
  scrub_key
  echo "$rc" > "$ZN_RC_FILE"
  echo "[entry] exit rc=$rc"
  exit "$rc"
}
trap on_exit EXIT

export TMPDIR="${ZN_WORK:-$PWD}/tmp"
mkdir -p "$TMPDIR"

# ----------------------------------------------------------------------------- CONFIG
IN=$(pwd)
RES="$ZN_OUT"
RESULT="$ZN_OUT/summary.json"
# ----------------------------------------------------------------------------- end of CONFIG

KIT_PYTHONPATH=${PYTHONPATH:-}
unset PYTHONPATH
kit_fail() { PYTHONPATH=$KIT_PYTHONPATH python3 -m znops.markers fail "$1"; return 0; }
result() { printf '{"result": "%s", "mode": "%s", "detail": "%s"}\n' "$1" "$MODE" "$2" > "$RESULT"; }

main() {
  set +e
  if grep -Evq '^[A-Z_]+=[A-Za-z0-9._+/:,-]*$' "$IN/params.env"; then echo "bad params.env"; return 1; fi
  # shellcheck disable=SC1091
  . "$IN/params.env"
  MODE=${MODE:-smoke}
  GCP_PROJECT=${GCP_PROJECT:-zn-gate}
  GCP_LOCATIONS=${GCP_LOCATIONS:-global}
  GCP_LOCATIONS=${GCP_LOCATIONS//,/ }
  AGY_FLAGS=${AGY_FLAGS:---dangerously-skip-permissions}
  AGY_MODEL=${AGY_MODEL:-}
  # znops.preflight full runs the entry with ZN_PREFLIGHT=1: that is the one-request mode.
  if [ "${ZN_PREFLIGHT:-0}" = 1 ]; then MODE=preflight; fi
  export DEBIAN_FRONTEND=noninteractive
  AGY_AUTH=${AGY_AUTH:-adc}
  KEYFILE=/dev/shm/agy-key
  if [ "$AGY_AUTH" = apikey ]; then
    # the key arrives through a 15-minute presigned URL kept in a curl config file (not in argv); the object is deleted by the launcher
    ( umask 077; curl -fsS -m 30 -K "$IN/key_url.cfg" -o "$KEYFILE" > /dev/null 2>&1 ); echo "key fetch rc=$?" > "$RES/key_fetch.rc"
    rm -f "$IN/key_url.cfg"
    if [ ! -s "$KEYFILE" ] || [ "$(wc -c < "$KEYFILE")" -gt 200 ]; then result BLOCKED "the API key could not be fetched (URL expired or object missing)"; return 0; fi
  fi

  # KF-019: HOME is set explicitly (a job runs as root with no usable HOME of its own).
  export HOME=/opt/znjob/home
  mkdir -p "$HOME" /opt/znjob/w
  cd "$HOME" || return 1
  local NODE24=v24.21.0
  local NODE24_SHA=fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6

  apt-get -o DPkg::Lock::Timeout=300 update -q && apt-get -o DPkg::Lock::Timeout=300 install -y -q git xz-utils jq ca-certificates curl util-linux coreutils || { kit_fail "abort: APT"; return 1; }
  local f=/opt/znjob/w/node.tar.xz
  curl -fsSLo "$f" "https://nodejs.org/dist/$NODE24/node-$NODE24-linux-x64.tar.xz" && echo "$NODE24_SHA  $f" | sha256sum -c - && tar -xJf "$f" -C /opt || { kit_fail "abort: NODE"; return 1; }
  export PATH=/opt/node-$NODE24-linux-x64/bin:$PATH
  { echo "host: $(uname -sr)"; echo "os: $(. /etc/os-release && echo "$PRETTY_NAME")"; echo "node: $(node -v)"; echo "date: $(date -u +%Y-%m-%dT%H:%MZ)"; echo "mode: $MODE"; } > "$RES/host.txt"

  # ---- zn-gate from the packed tree
  ( cd "$IN" && sha256sum "$TGZ" ) > "$RES/artifacts.sha256"
  npm install -g --no-audit --no-fund "$IN/$TGZ" > "$RES/zn_install.log" 2>&1 || { kit_fail "abort: ZN_INSTALL"; cat "$RES/zn_install.log"; return 1; }
  zn --version > "$RES/zn_version.txt" 2>&1
  echo "tree sha: ${SHA:-unknown}" >> "$RES/zn_version.txt"

  # ---- selftest: the kit against mock_agy.js (no agy, no account, no model): checks the kit's own scripts
  if [ "$MODE" = selftest ]; then
    cp "$(command -v node)" /opt/znjob/w/mock-node
    printf '#!/bin/sh\nexec /opt/znjob/w/mock-node %s "$@"\n' "$IN/kit/mock_agy.js" > /opt/znjob/w/mock-agy
    chmod +x /opt/znjob/w/mock-agy
    export AGY=/opt/znjob/w/mock-agy AGY_FLAGS AGY_MODEL=
    export EVID=$RES/evidence
    bash "$IN/kit/run_antigravity.sh" /opt/znjob/w/run "$IN/fake_secrets.js" > "$RES/scenarios.log" 2>&1
    local SRC=$?
    cat "$RES/scenarios.log"
    mkdir -p "$RES/raw"; cp -r /opt/znjob/w/run "$RES/raw/" 2>/dev/null
    if [ "$SRC" = 0 ]; then result SELFTEST_PASS "the kit passes against the mock"; else result SELFTEST_FAIL "rc $SRC against the mock"; fi
    return 0
  fi

  # ---- agy: the official install script (recorded by sha256)
  curl -fsSLo /opt/znjob/w/agy-install.sh https://antigravity.google/cli/install.sh || { kit_fail "abort: AGY_DOWNLOAD"; return 1; }
  sha256sum /opt/znjob/w/agy-install.sh > "$RES/agy_install.sha256"
  bash /opt/znjob/w/agy-install.sh > "$RES/agy_install.log" 2>&1
  echo "install script rc=$?" >> "$RES/agy_install.log"
  local AGY=$HOME/.local/bin/agy
  [ -x "$AGY" ] || { kit_fail "abort: AGY_INSTALL"; cat "$RES/agy_install.log"; return 1; }
  "$AGY" --version > "$RES/agy_version.txt" 2>&1; echo "rc=$?" >> "$RES/agy_version.txt"
  cat "$RES/agy_version.txt"
  "$AGY" --help > "$RES/agy_help.txt" 2>&1
  ls -la "$HOME/.local/bin" "$HOME/.gemini" "$HOME/.config" > "$RES/agy_files_after_install.txt" 2>&1

  # ---- Part B: no credential. A prompt must fail, not hang.
  mkdir -p /opt/znjob/noauth-home /opt/znjob/noauth-proj
  (
    export HOME=/opt/znjob/noauth-home
    unset AGY_ADC_AUTH GEMINI_API_KEY GOOGLE_API_KEY GOOGLE_APPLICATION_CREDENTIALS
    cd /opt/znjob/noauth-proj || exit 1
    timeout 120 "$AGY" -p "Reply with the word ok" --output-format json --print-timeout 1m < /dev/null > "$RES/noauth.json" 2> "$RES/noauth.err"
    echo "exit=$?" > "$RES/noauth.rc"
    timeout 60 "$AGY" models < /dev/null > "$RES/agy_models_noauth.txt" 2>&1; echo "exit=$?" >> "$RES/agy_models_noauth.txt"
    ls -laR "$HOME/.gemini" > "$RES/agy_files_after_noauth.txt" 2>&1
  )
  echo "no-auth prompt: $(cat "$RES/noauth.rc")"

  # ---- the identity of the VM (metadata server): names only, never a token
  local M=http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default
  { echo "service account: $(curl -s -m 5 -H 'Metadata-Flavor: Google' "$M/email" | sed 's/[0-9]\{6,\}/<project-number>/')"; echo "scopes: $(curl -s -m 5 -H 'Metadata-Flavor: Google' "$M/scopes" | tr '\n' ' ')"; } > "$RES/vm_identity.txt"
  cat "$RES/vm_identity.txt"

  if [ "$MODE" = smoke ]; then
    result SMOKE_OK "agy installed and checked without a credential"
    return 0
  fi

  if [ "$AGY_AUTH" = apikey ]; then
    # ---- preflight with the Gemini API key: ONE minimal request
    mkdir -p /opt/znjob/key-proj /opt/znjob/key-home/.gemini/antigravity-cli
    printf '{"modelProvider":"gemini"}\n' > /opt/znjob/key-home/.gemini/antigravity-cli/settings.json
    local KARGS=(); [ -n "$AGY_MODEL" ] && KARGS=(--model "$AGY_MODEL")
    (
      export HOME=/opt/znjob/key-home; GEMINI_API_KEY=$(cat "$KEYFILE"); export GEMINI_API_KEY
      unset AGY_ADC_AUTH GOOGLE_API_KEY
      cd /opt/znjob/key-proj || exit 1
      timeout 60 "$AGY" models < /dev/null > "$RES/key_models.txt" 2>&1; echo "exit=$?" >> "$RES/key_models.txt"
      timeout 180 "$AGY" -p "Reply with exactly the word: ok" --output-format json --print-timeout 2m "${KARGS[@]}" < /dev/null > "$RES/key_preflight.json" 2> "$RES/key_preflight.err"
      echo "exit=$?" > "$RES/key_preflight.rc"
    )
    echo "API-key preflight: $(cat "$RES/key_preflight.rc")"
    if [ "$(cat "$RES/key_preflight.rc")" != "exit=0" ] || ! grep -qi '"status": *"SUCCESS"\|ok' "$RES/key_preflight.json"; then
      result BLOCKED "agy did not answer a minimal request with the API key (see key_preflight.json and .err)"; return 0
    fi
    if [ "$MODE" = preflight ]; then result PREFLIGHT_OK "agy answered one request with the Gemini API key"; return 0; fi
    export AGY AGY_FLAGS AGY_MODEL AGY_APIKEY_AUTH=1
    GEMINI_API_KEY=$(cat "$KEYFILE"); export GEMINI_API_KEY
    unset AGY_ADC_AUTH GOOGLE_API_KEY
    export EVID=$RES/evidence
    bash "$IN/kit/run_antigravity.sh" /opt/znjob/w/run "$IN/fake_secrets.js" > "$RES/scenarios.log" 2>&1
    local KRC=$?
    cat "$RES/scenarios.log"
    unset GEMINI_API_KEY
    mkdir -p "$RES/raw"; cp -r /opt/znjob/w/run "$RES/raw/" 2>/dev/null
    rm -rf "$RES"/raw/run/*/proj/.git 2>/dev/null
    scrub_key
    case $KRC in 0) result PASS "all scenarios";; 3) result INCONCLUSIVE "a scenario was never tried by the model";; *) result FAIL "a scenario failed";; esac
    return 0
  fi
  # ---- preflight: ONE minimal request with the VM's own identity (ADC through the metadata server)
  mkdir -p /opt/znjob/adc-proj
  local OKLOC="" OKMODEL="" LOC MD TAG
  (
    export HOME=/opt/znjob/adc-home-models
    mkdir -p "$HOME"
    export AGY_ADC_AUTH=true GOOGLE_CLOUD_PROJECT=$GCP_PROJECT GOOGLE_CLOUD_QUOTA_PROJECT=$GCP_PROJECT GOOGLE_CLOUD_LOCATION=${GCP_LOCATIONS%% *}
    cd /opt/znjob/adc-proj || exit 1
    timeout 60 "$AGY" models < /dev/null > "$RES/adc_models.txt" 2>&1; echo "exit=$?" >> "$RES/adc_models.txt"
  )
  # agy's own default model first, then the slug its documentation uses (a permission error on the default
  # could also mean that this model does not exist for the project).
  for MD in "${AGY_MODEL:-default}" gemini-3.8-flash-medium; do
    for LOC in $GCP_LOCATIONS; do
      TAG=${LOC}_$MD
      (
        export HOME=/opt/znjob/adc-home-$TAG
        mkdir -p "$HOME"
        export AGY_ADC_AUTH=true GOOGLE_CLOUD_PROJECT=$GCP_PROJECT GOOGLE_CLOUD_QUOTA_PROJECT=$GCP_PROJECT GOOGLE_CLOUD_LOCATION=$LOC
        unset GEMINI_API_KEY GOOGLE_API_KEY
        cd /opt/znjob/adc-proj || exit 1
        MARGS=(); [ "$MD" = default ] || MARGS=(--model "$MD")
        timeout 180 "$AGY" -p "Reply with exactly the word: ok" --output-format json --print-timeout 2m "${MARGS[@]}" < /dev/null > "$RES/adc_$TAG.json" 2> "$RES/adc_$TAG.err"
        echo "exit=$?" > "$RES/adc_$TAG.rc"
      )
      echo "ADC preflight ($TAG): $(cat "$RES/adc_$TAG.rc")"
      if grep -q '"status": *"SUCCESS"' "$RES/adc_$TAG.json" 2>/dev/null && [ "$(cat "$RES/adc_$TAG.rc")" = "exit=0" ]; then OKLOC=$LOC; OKMODEL=$MD; break 2; fi
    done
  done
  if [ -z "$OKLOC" ]; then
    result BLOCKED "agy did not answer a minimal request with the VM identity (see adc_*.json and adc_*.err)"
    return 0
  fi
  [ "$OKMODEL" = default ] && OKMODEL=
  AGY_MODEL=$OKMODEL
  if [ "$MODE" = preflight ]; then
    result PREFLIGHT_OK "agy answered one request with the VM identity (location $OKLOC)"
    return 0
  fi

  # ---- the scenarios
  export AGY AGY_FLAGS AGY_MODEL AGY_ADC_AUTH=true GOOGLE_CLOUD_PROJECT=$GCP_PROJECT GOOGLE_CLOUD_QUOTA_PROJECT=$GCP_PROJECT GOOGLE_CLOUD_LOCATION=$OKLOC
  export EVID=$RES/evidence
  bash "$IN/kit/run_antigravity.sh" /opt/znjob/w/run "$IN/fake_secrets.js" > "$RES/scenarios.log" 2>&1
  local RC=$?
  cat "$RES/scenarios.log"
  mkdir -p "$RES/raw"; cp -r /opt/znjob/w/run "$RES/raw/" 2>/dev/null
  rm -rf "$RES"/raw/run/*/proj/.git 2>/dev/null
  case $RC in 0) result PASS "all scenarios";; 3) result INCONCLUSIVE "a scenario was never tried by the model";; *) result FAIL "a scenario failed";; esac
  return 0
}

MODE=smoke
set +e
main 2>&1 | tee "$ZN_OUT/workload.log"
rc=${PIPESTATUS[0]}
set -e
if [ "$rc" -ne 0 ]; then
  echo "[entry] workload failed rc=$rc"
  exit "$rc"
fi
if [ ! -s "$RESULT" ]; then
  echo "[entry] workload exited 0 but $RESULT is missing or empty"
  exit 3
fi
