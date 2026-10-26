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
# Node.js, in this order: `node` on the PATH of the hook (absolute entries outside the project only, see below), the usual
# install folders, and the program that runs
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
# ZCode starts this script by its absolute path (hooks.json: /bin/sh ${ZCODE_PLUGIN_ROOT}/scripts/zn-hook.sh, with the shell
# named by its full path, because ZCode looks a bare name up on its PATH before this script can clean it); any other
# form would depend on the folder the session runs in, so the launcher is then treated as missing.
case "$0" in /*) HERE_DIR=${0%/*} ;; *) HERE_DIR= ;; esac
HERE=$([ -n "$HERE_DIR" ] && CDPATH='' cd -- "$HERE_DIR" 2>/dev/null && pwd -P) || HERE=""

# Folders the agent works in are not trusted for programs: the folder the hook runs in, the project folder the host names
# (CLAUDE_PROJECT_DIR, CURSOR_PROJECT_DIR) and the git work tree around the hook's folder, compared by their real paths,
# and any node_modules folder. An absolute PATH entry there (a bin/ of the project, node_modules/.bin, a folder added by
# direnv) could hold a node or a sleep of the project's own. Your home folder and / never count as the project: everything
# would be untrusted there. A link is followed to its target, and the target's folder must be trusted too.
# The real path of a folder, in PHYS. Without a process per folder (a subshell is slow in Git Bash on Windows): cd -P into
# the folder and back to the hook's folder in this shell. Only when the hook's folder cannot be read is a subshell used.
CDPATH=
CWD_P=$(pwd -P 2>/dev/null) || CWD_P=""
phys() {
  PHYS=""
  _pf=$1
  [ -n "$_pf" ] || return 1
  # cd prints the folder and goes back to the previous one for "-": a folder named "-" is ./-, and nothing reaches the
  # hook's output (the agent reads it as the hook's answer).
  [ "$_pf" != - ] || _pf=./-
  if [ -z "$CWD_P" ]; then
    PHYS=$(cd -P -- "$_pf" >/dev/null 2>&1 && pwd -P) || return 1
    return 0
  fi
  cd -P -- "$_pf" >/dev/null 2>&1 || return 1
  PHYS=$PWD
  # Back to the hook's folder; if it is gone, no folder is trusted (the hook then finds no Node.js and refuses).
  cd -P -- "$CWD_P" >/dev/null 2>&1 || { PHYS=""; return 1; }
  [ -n "$PHYS" ]
}
dir_of() {
  DIR_OF=${1%/*}
  [ -n "$DIR_OF" ] || DIR_OF=/
}
HOME_P=""
if phys "${HOME:-/nonexistent}"; then HOME_P=$PHYS; fi
# One variable per project root, never a list to split: a folder name may hold any character but / (a newline too).
root_ok() {
  case "$PHYS" in "" | / | "$HOME_P") return 1 ;; esac
}
R1=""
R2=""
R3=""
R4=""
if phys "$CWD_P" && root_ok; then R1=$PHYS; fi
if phys "${CLAUDE_PROJECT_DIR:-}" && root_ok; then R2=$PHYS; fi
if phys "${CURSOR_PROJECT_DIR:-}" && root_ok; then R3=$PHYS; fi
_d=$CWD_P
while [ -n "$_d" ] && [ "$_d" != / ]; do
  if [ -e "$_d/.git" ]; then
    if phys "$_d" && root_ok; then R4=$PHYS; fi
    break
  fi
  _d=${_d%/*}
done
trusted_dir() {
  phys "$1" || return 1
  _p=$PHYS
  case "$_p/" in */node_modules/*) return 1 ;; esac
  for _r in "$R1" "$R2" "$R3" "$R4"; do
    [ -n "$_r" ] || continue
    case "$_p/" in "$_r"/*) return 1 ;; esac
  done
  return 0
}
READLINK=""
for c in /usr/bin/readlink /bin/readlink; do
  if [ -x "$c" ]; then READLINK=$c; break; fi
done
trusted_prog() {
  _f=$1
  _i=0
  dir_of "$_f"
  trusted_dir "$DIR_OF" || return 1
  while [ -L "$_f" ]; do
    [ -n "$READLINK" ] && [ "$_i" -lt 40 ] || return 1
    _t=$("$READLINK" -- "$_f") || return 1
    dir_of "$_f"
    case "$_t" in /*) _f=$_t ;; *) _f=$DIR_OF/$_t ;; esac
    dir_of "$_f"
    trusted_dir "$DIR_OF" || return 1
    _i=$((_i + 1))
  done
  return 0
}


# Only absolute, trusted PATH entries, for this script and everything it starts: a relative or empty entry points into the
# folder the session runs in (the project), where a node, sleep or ps of its own could have been placed.
OLDIFS=$IFS
IFS=:
set -f
SAFE_PATH=
for d in $PATH; do
  case "$d" in /*) trusted_dir "$d" && SAFE_PATH="${SAFE_PATH:+$SAFE_PATH:}$d" ;; esac
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
# The system's sleep, by its full path (never one found on the PATH).
SLEEP=""
for c in /bin/sleep /usr/bin/sleep; do
  if [ -x "$c" ]; then SLEEP=$c; break; fi
done
if [ -n "$SLEEP" ]; then
  MAIN=$$
  trap on_deadline USR1
  trap stop_watchdog EXIT
  (
    exec >/dev/null 2>&1 </dev/null
    "$SLEEP" "$DEADLINE" &
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
  [ -n "$1" ] && [ -f "$1" ] && [ -x "$1" ] && trusted_prog "$1" && node_ok "$1" && NODE="$1"
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
LS=""
SORT=""
PS=""
for c in /bin/ls /usr/bin/ls; do
  if [ -x "$c" ]; then LS=$c; break; fi
done
for c in /usr/bin/sort /bin/sort; do
  if [ -x "$c" ]; then SORT=$c; break; fi
done
for c in /bin/ps /usr/bin/ps; do
  if [ -x "$c" ]; then PS=$c; break; fi
done
if [ -z "$NODE" ] && [ -n "${HOME:-}" ] && [ -d "$HOME/.nvm/versions/node" ] && [ -n "$LS" ] && [ -n "$SORT" ]; then
  # shellcheck disable=SC2012 # a plain list of folders sorted by name
  for c in $("$LS" -1d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | "$SORT" -r); do
    try_node "$c" && break
  done
fi

# 3. the program that started this hook (ZCode's own Node.js)
if [ -z "$NODE" ] && [ -n "${PPID:-}" ]; then
  P=""
  [ -z "$READLINK" ] || P=$("$READLINK" "/proc/$PPID/exe" 2>/dev/null) || P=""
  [ -n "$P" ] || [ -z "$PS" ] || { P=$("$PS" -o comm= -p "$PPID" 2>/dev/null) || P=""; P=${P#"${P%%[! ]*}"}; }
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
