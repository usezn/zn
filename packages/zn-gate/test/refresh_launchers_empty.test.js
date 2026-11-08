'use strict';
/*
 * refreshLaunchers returns an empty list, and never throws, when there is nothing it can refresh:
 * the runner path does not exist, the launcher folder cannot be read, or the launcher folder is empty.
 * Every path is inside a temporary directory.
 */
process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const refresh = require('../lib/agents/refresh');
const { tempDir } = require('./helpers/tmp');

const posix = process.platform !== 'win32';

function setup(t) {
  const root = tempDir(t, 'zn-refresh-empty-');
  const hookDir = path.join(root, 'hooks');
  const runner = path.join(root, 'runner.js');
  fs.writeFileSync(runner, "process.exit(0);\n");
  return { root, hookDir, runner, env: { ZN_HOOK_DIR: hookDir } };
}

test('refreshLaunchers: a runner path that does not exist gives an empty list', (t) => {
  const c = setup(t);
  fs.mkdirSync(c.hookDir, { recursive: true });
  const missing = path.join(c.root, 'no-such-runner.js');
  assert.deepEqual(refresh.refreshLaunchers({ env: c.env, runnerPath: missing }), []);
  assert.deepEqual(refresh.refreshLaunchers({ env: c.env, runnerPath: missing, global: true }), []);
});

test('refreshLaunchers: a launcher folder that cannot be read gives an empty list', (t) => {
  const c = setup(t);
  // A regular file where the folder should be: reading it as a folder fails.
  fs.writeFileSync(c.hookDir, 'not a folder\n');
  assert.deepEqual(refresh.refreshLaunchers({ env: c.env, runnerPath: c.runner }), []);
});

test('refreshLaunchers: a launcher folder without read permission gives an empty list', { skip: !posix || (process.getuid && process.getuid() === 0) }, (t) => {
  const c = setup(t);
  fs.mkdirSync(c.hookDir, { recursive: true });
  fs.chmodSync(c.hookDir, 0o000);
  try {
    assert.deepEqual(refresh.refreshLaunchers({ env: c.env, runnerPath: c.runner }), []);
  } finally {
    fs.chmodSync(c.hookDir, 0o700);
  }
});

test('refreshLaunchers: an empty launcher folder gives an empty list and creates nothing', (t) => {
  const c = setup(t);
  fs.mkdirSync(c.hookDir, { recursive: true });
  assert.deepEqual(refresh.refreshLaunchers({ env: c.env, runnerPath: c.runner }), []);
  assert.deepEqual(fs.readdirSync(c.hookDir), []);
});

test('refreshLaunchers: main stays quiet and does not throw in these cases', (t) => {
  const c = setup(t);
  fs.mkdirSync(c.hookDir, { recursive: true });
  let out = '';
  refresh.main({ env: c.env, runnerPath: path.join(c.root, 'missing.js'), out: (s) => { out += s; } });
  refresh.main({ env: c.env, runnerPath: c.runner, out: (s) => { out += s; } });
  assert.equal(out, '');
});
