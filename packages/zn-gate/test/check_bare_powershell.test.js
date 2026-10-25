'use strict';
process.env.ZN_STATS = 'off';

// Hooks written by zn-gate 1.13 and earlier start powershell.exe by name on Windows. cmd.exe (Codex) and the process start of
// several agents look in the current folder first, so check asks for a reinstall, which writes the full path.

const test = require('node:test');
const assert = require('node:assert/strict');
const { hookEntries } = require('../lib/check')._internal;

const OLD = 'powershell.exe -NoProfile -NonInteractive -Command "& \'C:/Program Files/nodejs/node.exe\' \'C:/Users/u/AppData/Roaming/npm/node_modules/zn-gate/lib/hooks/runner.js\' codex"';

test('check reads command_windows for Codex on Windows, command elsewhere', () => {
  const tree = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: "'/home/u/.zn/hooks/zn-hook-codex.sh' PreToolUse", commandWindows: OLD }] }] } };
  const got = hookEntries(tree, 'codex')[0].command;
  assert.equal(got, process.platform === 'win32' ? OLD : "'/home/u/.zn/hooks/zn-hook-codex.sh' PreToolUse");
});

test('the reinstall reason is in lib/check.js with the reinstall fix', () => {
  const src = require('fs').readFileSync(require.resolve('../lib/check.js'), 'utf8');
  const i = src.indexOf('starts powershell.exe by name');
  assert.ok(i > 0);
  const block = src.slice(src.lastIndexOf('if (', i), src.indexOf('return out;', i));
  assert.match(block, /\/\^powershell\\\.exe \/i\.test\(String\(read\.command\)\.trim\(\)\)/);
  assert.match(block, /out\.fix = REINSTALL\(spec\.id\)/);
});
