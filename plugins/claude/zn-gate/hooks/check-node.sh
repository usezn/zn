#!/bin/sh
# SessionStart: warn when Node.js 18 or later is missing. The zn-gate hooks
# and MCP servers run on Node.js; without it every prompt is blocked.
# Prints nothing when Node.js is fine, and always exits 0.
v=`node --version 2>/dev/null` || v=''
major=${v#v}
major=${major%%.*}
case $major in
  ''|*[!0-9]*) major=0 ;;
esac
if [ "$major" -lt 18 ]; then
  printf '%s\n' '{"systemMessage":"zn-gate needs Node.js 18 or later on your PATH. Install the LTS release from https://nodejs.org and start a new session. Until then, zn-gate blocks every prompt."}'
fi
exit 0
