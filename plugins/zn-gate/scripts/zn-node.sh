#!/bin/sh
# Starts scripts/zn-launch.js of the zn-gate plugin with a Node.js found only in absolute PATH entries.
#
# Why: a hook command that starts `node` by name uses the first `node` on the PATH of the agent. A relative
# entry (".", an empty entry, "bin") points into the folder the session runs in, which is the project, and on Windows
# the current folder can be searched too. A node placed there would run with the user's rights, without zn's checks.
#
# Usage: zn-node.sh <Event> <zn-launch.js arguments...>
#   e.g. zn-node.sh PreToolUse hook claude-code
# The event JSON arrives on stdin and is passed to zn-launch.js. <Event> is only used to choose how to refuse when
# zn-launch.js cannot be started: the events that can stop a call are blocked (exit 2); the others only warn.
#
# What zn-launch.js prints and the exit code it ends with (0, 2 or anything else) pass through unchanged: it checks the Node.js
# version itself (and refuses when it is too old), and Claude Code's onFailure "block" handles a hook that ends with another code.
# This script adds one thing zn-launch.js cannot do for itself: a start deadline (DEADLINE seconds, under the 15-second
# timeout of the hooks). A Node.js that has not finished by then is stopped and the hook refuses like it does when
# Node.js is missing. Without a `sleep` program there is no deadline, and the other refusals still apply.

EVENT="${1:-}"
[ "$#" -gt 0 ] && shift

# Absolute script path only: the folder of this script is where zn-launch.js is; any other form would depend on the
# folder the session runs in (the project), so the launcher is then treated as missing. A Windows path (C:\... or C:/...,
# Git Bash) counts as absolute too; the folder is whatever precedes the last / or \.
BS='\'
HERE_DIR=
case "$0" in
  /* | [A-Za-z]:*)
    A=${0%/*}
    B=${0%"$BS"*}
    if [ "$A" = "$0" ]; then HERE_DIR=$B; elif [ "$B" = "$0" ]; then HERE_DIR=$A; elif [ "${#A}" -ge "${#B}" ]; then HERE_DIR=$A; else HERE_DIR=$B; fi
    [ "$HERE_DIR" != "$0" ] || HERE_DIR=
    ;;
esac
HERE=$([ -n "$HERE_DIR" ] && CDPATH='' cd -- "$HERE_DIR" 2>/dev/null && pwd -P) || HERE=""

# Only absolute PATH entries, for this script and everything it starts.
OLDIFS=$IFS
IFS=:
set -f
SAFE_PATH=
for d in $PATH; do
  case "$d" in /*) SAFE_PATH="${SAFE_PATH:+$SAFE_PATH:}$d" ;; esac
done
set +f
IFS=$OLDIFS
[ -n "$SAFE_PATH" ] || SAFE_PATH=/usr/bin:/bin
PATH=$SAFE_PATH
export PATH

# Refusal: exit 2 and the reason on stderr where that blocks; elsewhere exit 0 with a message for the user.
refuse() {
  case "$EVENT" in
    PreToolUse | PermissionRequest | UserPromptSubmit | UserPromptExpansion)
      printf '%s\n' "zn: $1 This call was blocked because zn could not check it. Fix it, or turn off the zn-gate plugin (claude plugin disable zn-gate@usezn)." >&2
      exit 2
      ;;
    *)
      printf '{"systemMessage":"zn is NOT protecting this session: %s"}\n' "$1"
      exit 0
      ;;
  esac
}

LAUNCH="$HERE/zn-launch.js"
[ -n "$HERE" ] && [ -f "$LAUNCH" ] || refuse "the plugin launcher (scripts/zn-launch.js) is missing."

DEADLINE=13
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

NODE=""
OLDIFS=$IFS
IFS=:
set -f
for d in $PATH; do
  case "$d" in /*) ;; *) continue ;; esac
  for n in node node.exe; do
    if [ -f "$d/$n" ] && [ -x "$d/$n" ]; then NODE="$d/$n"; break; fi
  done
  [ -z "$NODE" ] || break
done
set +f
IFS=$OLDIFS

# The usual install folders (an app often starts with a short PATH).
if [ -z "$NODE" ]; then
  for c in /usr/local/bin/node /opt/homebrew/bin/node /usr/bin/node "/c/Program Files/nodejs/node.exe" "${HOME:-/nonexistent}/.volta/bin/node" "${HOME:-/nonexistent}/.local/share/fnm/aliases/default/bin/node"; do
    if [ -f "$c" ] && [ -x "$c" ]; then NODE="$c"; break; fi
  done
fi
if [ -z "$NODE" ] && [ -n "${HOME:-}" ] && [ -d "$HOME/.nvm/versions/node" ]; then
  # shellcheck disable=SC2012 # a plain list of folders sorted by name
  for c in $(ls -1d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -r); do
    if [ -f "$c" ] && [ -x "$c" ]; then NODE="$c"; break; fi
  done
fi

[ -n "$NODE" ] || refuse "no Node.js was found for the hook (looked in the absolute entries of the PATH and the usual install folders)."

"$NODE" "$LAUNCH" "$@" <&3 &
CUR=$!
wait "$CUR"
rc=$?
CUR=""
exit "$rc"
