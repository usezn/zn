#!/bin/sh
# zn-gate hook for the Antigravity CLI (plugin copy).
#
# Antigravity runs this as `sh scripts/zn-hook.sh` from the folder the plugin is installed in (measured on the CLI
# 1.4.7, Linux), with the tool call as JSON on stdin, and reads the answer from stdout: {"decision": "...", "reason": "..."}.
# It denied every tool call whose hook failed, timed out, exited with a non-zero code or printed something that is
# not a decision, but the documentation does not promise that. So this script never relies on it: it runs
# zn-launch.js, which checks the zn-gate copy shipped inside this plugin byte for byte and runs it, and when anything
# stops that from happening (no usable Node.js, a missing file, a failure, a hang) it prints a deny decision itself,
# with the reason, instead of letting Antigravity guess.
#
# Node.js, in this order: `node` on the PATH of the hook, then the usual install folders. A candidate is used only if
# it is Node.js 20.19 or later (21.7 or later on 21).
#
# Start deadline: the hook has 15 seconds (hooks.json). A Node.js that hangs while the hook starts (the version probe
# or the launch) must not run into that timeout: DEADLINE seconds after the script starts, the hook prints the deny
# decision and stops the Node.js it started. A watchdog sends this shell a signal; Node.js runs in the background and
# the shell waits for it, because a shell only handles a signal once its foreground command is done. Without a
# `sleep` program there is no watchdog, and the other refusals still apply.

case "$0" in */*) HERE_DIR=${0%/*} ;; *) HERE_DIR=. ;; esac
HERE=$(CDPATH= cd -- "$HERE_DIR" 2>/dev/null && pwd -P) || HERE=""
LAUNCH="$HERE/zn-launch.js"

# Refusal: a deny decision on stdout (exit 0). The messages given to it hold no quote or backslash.
refuse() {
  printf '%s\n' '{"decision":"deny","reason":"zn: '"$1"' This call was blocked because zn could not check it. Ask the user to fix it, or to turn off the zn-gate plugin with: agy plugin disable zn-gate"}'
  exit 0
}

[ -n "$HERE" ] && [ -f "$LAUNCH" ] || refuse "the plugin's launcher (scripts/zn-launch.js) is missing."

DEADLINE=12
exec 3<&0
CUR=""
WD=""
stop_watchdog() {
  [ -z "$WD" ] || kill "$WD" 2>/dev/null
}
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
  "$1" -e 'const v=process.versions.node.split(".").map(Number);const vm=require("vm");process.exit(((v[0]>21||(v[0]===21&&v[1]>=7)||(v[0]===20&&v[1]>=19))&&vm.constants&&vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER)?0:1)' >/dev/null 2>&1 </dev/null &
  CUR=$!
  wait "$CUR"
  _rc=$?
  CUR=""
  return "$_rc"
}

NODE=""
try_node() {
  [ -n "$1" ] && [ -x "$1" ] && node_ok "$1" && NODE="$1"
}

# 1. PATH
OLDIFS=$IFS
IFS=:
for d in $PATH; do
  [ -n "$d" ] || continue
  try_node "$d/node" && break
done
IFS=$OLDIFS

# 2. usual install folders (the CLI can start with a short PATH)
if [ -z "$NODE" ]; then
  for c in /usr/local/bin/node /opt/homebrew/bin/node /usr/bin/node "${HOME:-/nonexistent}/.volta/bin/node" "${HOME:-/nonexistent}/.local/share/fnm/aliases/default/bin/node"; do
    try_node "$c" && break
  done
fi
if [ -z "$NODE" ] && [ -n "${HOME:-}" ] && [ -d "$HOME/.nvm/versions/node" ]; then
  for c in $(ls -1d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -r); do
    try_node "$c" && break
  done
fi

[ -n "$NODE" ] || refuse "no Node.js 20.19 or later was found for the hook (looked in the PATH and the usual install folders)."

# The launcher prints a decision and exits 0 by itself; anything else is a failure and is refused here.
"$NODE" "$LAUNCH" hook antigravity <&3 &
CUR=$!
wait "$CUR"
rc=$?
CUR=""
case "$rc" in
  0) exit 0 ;;
  *) refuse "the hook ended with exit code $rc." ;;
esac
