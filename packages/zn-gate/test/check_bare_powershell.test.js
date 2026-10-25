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

test('check reads the powershell command of Copilot CLI on Windows, bash elsewhere', () => {
  const tree = { hooks: { preToolUse: [{ type: 'command', bash: 'zn hook copilot', powershell: 'powershell.exe -NoProfile -NonInteractive -Command "zn hook copilot"' }] } };
  const got = hookEntries(tree, 'copilot').map((e) => e.command);
  assert.deepEqual(got, [process.platform === 'win32' ? tree.hooks.preToolUse[0].powershell : 'zn hook copilot']);
});

test('check finds Git Bash the way Claude Code is set up on Windows: the setting, then bin/bash next to git on the PATH', { skip: process.platform === 'win32' }, (t) => {
  const { gitBash } = require('../lib/check')._internal;
  const fs = require('fs');
  const path = require('path');
  const { tempDir } = require('./helpers/tmp');
  const git = tempDir(t, 'zn-gitbash-');
  fs.mkdirSync(path.join(git, 'cmd'));
  fs.mkdirSync(path.join(git, 'bin'));
  fs.writeFileSync(path.join(git, 'cmd', 'git'), '#!/bin/sh\n', { mode: 0o755 });
  fs.writeFileSync(path.join(git, 'bin', 'bash'), '#!/bin/sh\n', { mode: 0o755 });
  // Only Git/cmd on the PATH (a default Git for Windows install): bin/bash next to it.
  assert.equal(gitBash({ PATH: path.join(git, 'cmd') }), path.join(git, 'bin', 'bash'));
  // The documented setting wins when it names a file.
  const other = path.join(tempDir(t, 'zn-gitbash2-'), 'bash');
  fs.writeFileSync(other, '#!/bin/sh\n', { mode: 0o755 });
  assert.equal(gitBash({ PATH: path.join(git, 'cmd'), CLAUDE_CODE_GIT_BASH_PATH: other }), other);
  // A relative setting or a git only on a relative PATH entry is not used.
  assert.equal(gitBash({ PATH: '.:bin', CLAUDE_CODE_GIT_BASH_PATH: 'bash' }), null);
});
