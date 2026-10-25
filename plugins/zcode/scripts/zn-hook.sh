#!/bin/sh
# zn-gate hook for the ZCode desktop app (plugin copy).
#
# ZCode does not document what happens when a hook fails; in our tests with the desktop app 3.16.3 on Linux a
# failed hook let the call run and only exit code 2 blocked it. So this script
# does one job: it runs zn-launch.js, which checks the zn-gate copy shipped inside this plugin byte for
# byte and runs it, and when anything stops that from happening (no usable Node.js, a missing file, an
# unexpected exit code) it blocks instead of letting the call run.
#
# Usage: zn-hook.sh <Event>    (the event JSON arrives on stdin; the event name is only used to choose how to refuse)
#
# Node.js, in this order: `node` on the PATH of the hook, the usual install folders, and the program that runs
# ZCode's agent (the app's own Node.js: it is started as `ELECTRON_RUN_AS_NODE=1 <app> zcode.cjs ...`, and is this
# script's parent). A candidate is used only if it is Node.js 20.19 or later (21.7 or later on 21).
#
# Start deadline: this plugin sets a 30-second timeout on its hooks (hooks.json, timeoutMs), and in our tests a
# call whose hook timed out ran. So a Node.js that hangs while the hook starts (the version probe or the launch) must not run into that
# timeout: DEADLINE seconds (28, the same deadline as the launcher of `zn hooks install zcode`, which leaves the hook its
# own 25-second answer deadline) after the script starts, the hook answers like it does when the check fails (block, or only
# a warning on PostToolUse) and stops the Node.js it started. A watchdog sends this shell a signal; Node.js runs in the
# background and the shell waits for it, because a shell only handles a signal once its foreground command is done.
# Without a `sleep` program there is no watchdog, and the other refusals still apply.

EVENT="${1:-}"
# ZCode starts this script by its absolute path (hooks.json: sh ${ZCODE_PLUGIN_ROOT}/scripts/zn-hook.sh); any other
# form would depend on the folder the session runs in, so the launcher is then treated as missing.
case "$0" in /*) HERE_DIR=${0%/*} ;; *) HERE_DIR= ;; esac
HERE=$([ -n "$HERE_DIR" ] && CDPATH='' cd -- "$HERE_DIR" 2>/dev/null && pwd -P) || HERE=""

# Only absolute PATH entries, for this script and everything it starts: a relative or empty entry points into the
# folder the session runs in (the project), where a node, sleep or ps of its own could have been placed.
OLDIFS=$IFS
IFS=:
set -f
SAFE_PATH=
for d in $PATH; do
  case "$d" in /*) SAFE_PATH="${SAFE_PATH:+$SAFE_PATH:}$d" ;; esac
done
set +f
IFS=$OLDIFS
# With no absolute entry at all, an empty PATH would make the shell look in the current folder: use the system folders.
[ -n "$SAFE_PATH" ] || SAFE_PATH=/usr/bin:/bin
PATH=$SAFE_PATH
export PATH
LAUNCH="$HERE/zn-launch.js"

# Refusal: exit 2 and the reason on stderr for the events where that blocks (the others only warn).
refuse() {
  case "$EVENT" in
    PreToolUse | PermissionRequest | UserPromptSubmit | "")
      printf '%s\n' "zn: $1 This call was blocked because zn could not check it. Ask the user to fix it, or to turn off the zn-gate plugin in ZCode (Settings, Plugins)." >&2
      exit 2
      ;;
    *)
      printf '%s\n' "zn is NOT protecting this session: $1" >&2
      exit 0
      ;;
  esac
}

[ -n "$HERE" ] && [ -f "$LAUNCH" ] || refuse "the plugin's launcher (scripts/zn-launch.js) is missing."

DEADLINE=28
exec 3<&0
CUR=""
WD=""
# shellcheck disable=SC2329 # called by trap
stop_watchdog() {
  [ -z "$WD" ] || kill "$WD" 2>/dev/null
}
# shellcheck disable=SC2329 # called by trap
on_deadline() {
  trap '' USR1
  [ -z "$CUR" ] || kill "$CUR" 2>/dev/null
  refuse "the hook did not finish starting within $DEADLINE seconds."
}
if command -v sleep >/dev/null 2>&1; then
  MAIN=$$
  trap on_deadline USR1
  trap stop_watchdog EXIT
  (
    exec >/dev/null 2>&1 </dev/null
    sleep "$DEADLINE" &
    s=$!
    trap 'kill "$s" 2>/dev/null; exit 0' TERM
    wait "$s" && kill -USR1 "$MAIN"
  ) &
  WD=$!
fi

# Node.js 20.19+ with the module loader the launcher needs.
node_ok() {
  ELECTRON_RUN_AS_NODE=1 "$1" -e 'const v=process.versions.node.split(".").map(Number);const vm=require("vm");process.exit(((v[0]>21||(v[0]===21&&v[1]>=7)||(v[0]===20&&v[1]>=19))&&vm.constants&&vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER)?0:1)' >/dev/null 2>&1 </dev/null &
  CUR=$!
  wait "$CUR"
  _rc=$?
  CUR=""
  return "$_rc"
}

NODE=""
APP_NODE=""
try_node() {
  [ -n "$1" ] && [ -x "$1" ] && node_ok "$1" && NODE="$1"
}

# 1. PATH (absolute entries only, see above)
OLDIFS=$IFS
IFS=:
set -f
for d in $PATH; do
  case "$d" in /*) ;; *) continue ;; esac
  try_node "$d/node" && break
done
set +f
IFS=$OLDIFS

# 2. usual install folders (a desktop app often starts with a short PATH)
if [ -z "$NODE" ]; then
  for c in /usr/local/bin/node /opt/homebrew/bin/node /usr/bin/node "${HOME:-/nonexistent}/.volta/bin/node" "${HOME:-/nonexistent}/.local/share/fnm/aliases/default/bin/node"; do
    try_node "$c" && break
  done
fi
if [ -z "$NODE" ] && [ -n "${HOME:-}" ] && [ -d "$HOME/.nvm/versions/node" ]; then
  # shellcheck disable=SC2012 # a plain list of folders sorted by name
  for c in $(ls -1d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -r); do
    try_node "$c" && break
  done
fi

# 3. the program that started this hook (ZCode's own Node.js)
if [ -z "$NODE" ] && [ -n "${PPID:-}" ]; then
  P=$(readlink "/proc/$PPID/exe" 2>/dev/null) || P=""
  [ -n "$P" ] || { P=$(ps -o comm= -p "$PPID" 2>/dev/null) || P=""; P=${P#"${P%%[! ]*}"}; }
  case "$P" in /*) try_node "$P" && APP_NODE=1 ;; esac
fi

[ -n "$NODE" ] || refuse "no Node.js 20.19 or later was found for the hook (looked in the PATH, the usual install folders and the app itself)."

# The launcher exits 0 (done) or 2 (blocked) by itself; anything else is a failure and is refused here.
# (ELECTRON_RUN_AS_NODE is set only when the Node.js is the app's own program.)
if [ -n "$APP_NODE" ]; then
  ELECTRON_RUN_AS_NODE=1 "$NODE" "$LAUNCH" hook zcode <&3 &
else
  "$NODE" "$LAUNCH" hook zcode <&3 &
fi
CUR=$!
wait "$CUR"
rc=$?
CUR=""
case "$rc" in
  0 | 2) exit "$rc" ;;
  *) refuse "the hook ended with exit code $rc." ;;
esac
