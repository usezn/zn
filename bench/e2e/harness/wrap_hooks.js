#!/usr/bin/env node
'use strict';
/**
 * Prepares the hooks.json that `zn hooks install codex` wrote, for one
 * scenario of run_codex_scenarios.sh: every zn hook goes through spy_hook.js
 * (which logs what Codex sent and what zn answered), and some scenarios
 * change which hooks are there.
 *
 *   node wrap_hooks.js <hooks.json> <spy_hook.js> <scenario> <third_party_hook.js> <third party log> <spy log>
 */

const fs = require('fs');

const [file, spy, scenario, third, thirdLog, spyLog] = process.argv.slice(2);
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";

for (const groups of Object.values(data.hooks)) {
  for (const g of groups) {
    for (const h of g.hooks) h.command = q(process.execPath) + ' ' + q(spy) + ' ' + q(spyLog) + ' ' + h.command;
  }
}
if (scenario === 'permission') {
  // Only the approval hook: the call then reaches the approval prompt, where PermissionRequest runs.
  delete data.hooks.PreToolUse;
}
if (scenario === 'thirdparty') {
  data.hooks.PreToolUse.unshift({ matcher: '^Bash$', hooks: [{ type: 'command', command: q(process.execPath) + ' ' + q(third) + ' ' + q(thirdLog), timeout: 30 }] });
}
fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
