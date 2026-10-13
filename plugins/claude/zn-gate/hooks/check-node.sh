#!/bin/sh
# SessionStart: warn when the zn-gate hooks cannot run, because every prompt
# is then blocked:
#   - Node.js 18 or later is missing from PATH;
#   - the zn-gate package was not installed into this plugin (npm missing at
#     install time, or a copy of the plugin installed without dependencies).
# Prints nothing when everything is in place, and always exits 0.
root=${CLAUDE_PLUGIN_ROOT:-}
if [ -z "$root" ]; then
  root=`dirname "$0"`/..
fi
v=`node --version 2>/dev/null` || v=''
major=${v#v}
major=${major%%.*}
case $major in
  ''|*[!0-9]*) major=0 ;;
esac
if [ "$major" -lt 18 ]; then
  printf '%s\n' '{"systemMessage":"zn-gate needs Node.js 18 or later on your PATH. Install the LTS release from https://nodejs.org and start a new session. Until then, zn-gate blocks every prompt."}'
elif [ ! -f "$root/node_modules/zn-gate/lib/hooks/runner.js" ]; then
  printf '%s\n' '{"systemMessage":"zn-gate is not fully installed: its npm package is missing from the plugin folder. Run: claude plugin update zn-gate@usezn (npm must be on your PATH), then start a new session. Until then, zn-gate blocks every prompt."}'
fi
exit 0
