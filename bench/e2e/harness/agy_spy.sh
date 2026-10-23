#!/bin/sh
# Hook spy for the Antigravity CLI. Antigravity runs a hook command split on spaces, with no shell, so the spy is
# a plain script: it needs no Node.js (a scenario removes Node.js on purpose) and its path has no quote.
#
#   agy_spy.sh <log file> <real hook command and its arguments...>
#
# Appends one line per call to the log: <UTC time> <exit code> <stdin> <stdout> <stderr>, each of the three streams
# in base64 ("-" when empty). Then passes stdout, stderr and the exit code through unchanged.
LOG=$1
shift
TMP="$LOG.$$"
cat > "$TMP.in"
"$@" < "$TMP.in" > "$TMP.out" 2> "$TMP.err"
RC=$?
enc() { if [ -s "$1" ]; then base64 -w0 < "$1"; else printf '%s' '-'; fi; }
printf '%s %s %s %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)" "$RC" "$(enc "$TMP.in")" "$(enc "$TMP.out")" "$(enc "$TMP.err")" >> "$LOG"
cat "$TMP.out"
cat "$TMP.err" >&2
rm -f "$TMP.in" "$TMP.out" "$TMP.err"
exit "$RC"
