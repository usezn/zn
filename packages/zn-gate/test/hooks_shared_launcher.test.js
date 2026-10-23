'use strict';

// Two Claude Code profiles (two CLAUDE_CONFIG_DIRs) share one launcher script under ~/.zn/hooks.
// Uninstalling zn in one profile must not delete it: the other profile's hooks would then exit 127,
// which Claude Code treats as a non-blocking error, and the agent would run unprotected. Values are
// fake; everything runs in a temporary home.

process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { getAdapter } = require('../lib/agents');
const launcher = require('../lib/agents/launcher');
const { check } = require('../lib/check');
const { tempDir } = require('./helpers/tmp');

const claude = getAdapter('claude-code');
const RUNNER = path.resolve(__dirname, '..', 'lib', 'hooks', 'runner.js');
const posix = process.platform !== 'win32';

function profiles(t) {
  const home = tempDir(t, 'zn-b1091-');
  const base = { HOME: home, ZN_HOME: path.join(home, '.zn'), PATH: process.env.PATH };
  const a = { ...base, CLAUDE_CONFIG_DIR: path.join(home, 'profile-a') };
  const b = { ...base, CLAUDE_CONFIG_DIR: path.join(home, 'profile-b') };
  for (const env of [a, b]) claude.install({ env, home, nodePath: process.execPath, runnerPath: RUNNER, mcp: false });
  return { home, a, b, file: launcher.launcherFile('claude-code', { env: a, home }) };
}

function hookCommand(env, home) {
  const data = JSON.parse(fs.readFileSync(claude.settingsFile({ env, home }), 'utf8'));
  return data.hooks.PreToolUse[0].hooks[0].command;
}

test('claude-code: uninstalling one profile keeps the launcher the other profile uses', { skip: !posix }, (t) => {
  const { home, a, b, file } = profiles(t);
  assert.ok(fs.existsSync(file));
  assert.equal(claude.uninstall({ env: a, home, mcp: false }).removed, 1);
  assert.equal(fs.existsSync(file), true, 'the shared launcher is still there');
  // The command of profile B still starts: the launcher answers (it does not exit 127).
  const r = spawnSync('sh', ['-c', hookCommand(b, home)], { input: '{}', encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.notEqual(r.status, 127, r.stderr);
});

test('claude-code: after one profile is uninstalled, check still says the other is protected', { skip: !posix }, async (t) => {
  const { home, a, b } = profiles(t);
  claude.uninstall({ env: a, home, mcp: false });
  const r = (await check({ home, env: b, cwd: tempDir(t, 'zn-b1091-cwd-') })).results.find((x) => x.id === 'claude-code');
  assert.equal(r.state, 'protected', r.problem);
});

test('claude-code: a hook that points at a missing launcher is reported as not protected, with the fix', { skip: !posix }, async (t) => {
  const { home, b, file } = profiles(t);
  fs.unlinkSync(file);
  const r = (await check({ home, env: b, cwd: tempDir(t, 'zn-b1091-cwd-') })).results.find((x) => x.id === 'claude-code');
  assert.equal(r.state, 'not-protected');
  assert.match(r.problem, /its hook cannot start: its launcher script \(.*zn-hook-claude-code\.sh\) is missing or was changed/);
  assert.match(r.fix, /zn hooks install claude-code/);
});

test('the machine-wide uninstall (removeLauncher) still removes the launcher', { skip: !posix }, (t) => {
  const { home, a, file } = profiles(t);
  claude.uninstall({ env: a, home, mcp: false, removeLauncher: true });
  assert.equal(fs.existsSync(file), false);
});
