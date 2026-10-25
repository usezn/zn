#!/bin/sh
# zn-gate hook for the OpenAI Codex plugin (plugin copy).
#
# Codex lets a call run when a hook cannot start, crashes, times out or answers in a way it does not understand: the
# hook is "marked as failed" and Codex "continues". Only exit code 2 (PreToolUse, UserPromptSubmit) or a deny decision
# (PermissionRequest) blocks. So this script does one job: it runs zn-launch.js, which checks the zn-gate copy shipped
# inside this plugin byte for byte and runs it, and when anything stops that from happening (no usable Node.js, a
# missing file, an unexpected exit code, no answer before the deadline) it blocks, on the events where Codex lets a hook
# block, instead of letting the call run. On the other events it only warns, with a message Codex shows to the user.
#
# Usage: zn-hook.sh <Event>    (the event JSON arrives on stdin; the event name is only used to choose how to refuse)
#
# Node.js, in this order: `node` on the PATH of the hook, then the usual install folders. A candidate is used only if
# it is Node.js 20.19 or later (21.7 or later on 21).
#
# Start deadline: Codex stops a zn hook after 30 seconds (hooks/hooks.json), and what it does with a call whose hook
# timed out is "reports a hook failure", not a block. So a Node.js that hangs while the hook starts (the version probe or
# the launch) must not run into that timeout: DEADLINE seconds after the script starts, the hook answers like it does
# when the check fails and stops the Node.js it started. A watchdog sends this shell a signal; Node.js runs in the
# background and the shell waits for it, because a shell only handles a signal once its foreground command is done.
# Without a `sleep` program there is no watchdog, and the other refusals still apply.

EVENT="${1:-}"
# Codex starts this script by its absolute path (hooks.json); any other form would depend on the folder the
# session runs in, so the launcher is then treated as missing.
case "$0" in /*) HERE_DIR=${0%/*} ;; *) HERE_DIR= ;; esac
HERE=$([ -n "$HERE_DIR" ] && CDPATH='' cd -- "$HERE_DIR" 2>/dev/null && pwd -P) || HERE=""

# Only absolute PATH entries, for this script and everything it starts: a relative or empty entry points into a
# folder the agent chose, where a node, sleep or ps of its own could have been placed.
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

# Refusal. PreToolUse and UserPromptSubmit: exit 2 and the reason on stderr. PermissionRequest: the documented deny
# decision. Any other event cannot block, so the user only gets a warning. The texts hold no quote or backslash: they go
# into JSON as they are.
refuse() {
  case "$EVENT" in
    PreToolUse | UserPromptSubmit | "")
      printf '%s\n' "zn: $1 This call was blocked because zn could not check it. Ask the user to fix it, or to turn off the zn-gate plugin in Codex (/plugins)." >&2
      exit 2
      ;;
    PermissionRequest)
      printf '%s\n' "{\"hookSpecificOutput\":{\"hookEventName\":\"PermissionRequest\",\"decision\":{\"behavior\":\"deny\",\"message\":\"zn: $1 This request was denied because zn could not check it.\"}}}"
      exit 0
      ;;
    *)
      printf '%s\n' "{\"systemMessage\":\"zn is NOT protecting this session: $1\"}"
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
# Node.js runs in a process group of its own where setsid exists, so the deadline stops what it started too.
GROUP=""
for g in /usr/bin/setsid /bin/setsid; do [ -x "$g" ] && { GROUP=$g; break; }; done
# shellcheck disable=SC2329 # called by trap
on_deadline() {
  trap '' USR1
  if [ -n "$CUR" ]; then
    [ -z "$GROUP" ] || kill -TERM -"$CUR" 2>/dev/null
    kill "$CUR" 2>/dev/null
  fi
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
  if [ -n "$GROUP" ]; then "$GROUP" "$1" -e 'const v=process.versions.node.split(".").map(Number);const vm=require("vm");process.exit(((v[0]>21||(v[0]===21&&v[1]>=7)||(v[0]===20&&v[1]>=19))&&vm.constants&&vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER)?0:1)' >/dev/null 2>&1 </dev/null &
  else "$1" -e 'const v=process.versions.node.split(".").map(Number);const vm=require("vm");process.exit(((v[0]>21||(v[0]===21&&v[1]>=7)||(v[0]===20&&v[1]>=19))&&vm.constants&&vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER)?0:1)' >/dev/null 2>&1 </dev/null &
  fi
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
set -f
for d in $PATH; do
  case "$d" in /*) ;; *) continue ;; esac
  try_node "$d/node" && break
done
set +f
IFS=$OLDIFS

# 2. usual install folders (an app often starts with a short PATH)
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

[ -n "$NODE" ] || refuse "no Node.js 20.19 or later was found for the hook (looked in the PATH and the usual install folders)."

# The launcher exits 0 (done) or 2 (blocked) by itself; anything else is a failure and is refused here.
if [ -n "$GROUP" ]; then "$GROUP" "$NODE" "$LAUNCH" hook codex <&3 &
else "$NODE" "$LAUNCH" hook codex <&3 &
fi
CUR=$!
wait "$CUR"
rc=$?
CUR=""
case "$rc" in
  0 | 2) exit "$rc" ;;
  *) refuse "the hook ended with exit code $rc." ;;
esac
