'use strict';
// Uninstalling the Claude Code hooks removes only zn's entries: the user's own hook and the
// settings that have nothing to do with hooks stay. Everything lives in temporary folders.
process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { getAdapter } = require('../lib/agents');
const { tempDir } = require('./helpers/tmp');

const RUNNER = path.join(__dirname, '..', 'lib', 'hooks', 'runner.js');
const USER_CMD = 'echo example-user-hook';

test('hooks uninstall (claude-code) removes zn entries and keeps the user hook and settings', (t) => {
  const home = tempDir(t, 'zn-unin-home-');
  const cwd = tempDir(t, 'zn-unin-cwd-');
  const env = { HOME: home, USERPROFILE: home, PATH: '' };
  const opts = { scope: 'user', projectDir: cwd, home, env, nodePath: process.execPath, runnerPath: RUNNER, mcp: false };
  const adapter = getAdapter('claude-code');

  const userGroup = { matcher: 'Bash', hooks: [{ type: 'command', command: USER_CMD }] };
  const original = { theme: 'example-theme', hooks: { PreToolUse: [userGroup] }, permissions: { allow: ['Read'] } };
  const dir = path.join(home, '.claude');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify(original, null, 2) + '\n');

  adapter.install(opts);
  const installed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const countGroups = (doc) => Object.values(doc.hooks).reduce((n, g) => n + g.length, 0);
  assert.ok(countGroups(installed) > 1, 'install added zn hooks next to the user hook');
  assert.ok(JSON.stringify(installed).includes(USER_CMD), 'user hook survives the install');

  const rep = adapter.uninstall(opts);
  assert.ok(rep.removed > 0, 'zn entries were reported removed');
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(after, original);
  assert.ok(!/runner\.js/.test(JSON.stringify(after)), 'no zn entry left');
});
