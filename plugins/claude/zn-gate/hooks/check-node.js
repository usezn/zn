'use strict';
// SessionStart: warn when the zn-gate hooks cannot run, because every prompt
// is then blocked:
//   - Node.js older than 18 (when Node.js is missing altogether, Claude Code
//     cannot start this script and reports that `node` was not found);
//   - the zn-gate package was not installed into this plugin (npm missing at
//     install time, or a copy of the plugin installed without dependencies).
// Prints nothing when everything is in place, and always exits 0.
const fs = require('fs');
const path = require('path');

const root = process.env.CLAUDE_PLUGIN_ROOT || path.join(__dirname, '..');
const major = Number(String(process.versions.node || '0').split('.')[0]) || 0;
let message = null;
if (major < 18) {
  message = 'zn-gate needs Node.js 18 or later on your PATH (found ' + process.version + '). Install the LTS release from https://nodejs.org and start a new session. Until then, zn-gate blocks every prompt.';
} else if (!fs.existsSync(path.join(root, 'node_modules', 'zn-gate', 'lib', 'hooks', 'runner.js'))) {
  message = 'zn-gate is not fully installed: its npm package is missing from the plugin folder. Run: claude plugin update zn-gate@usezn (npm must be on your PATH), then start a new session. Until then, zn-gate blocks every prompt.';
}
if (message) process.stdout.write(JSON.stringify({ systemMessage: message }) + '\n');
process.exit(0);
