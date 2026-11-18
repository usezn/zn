'use strict';

// The postinstall notice (lib/agents/refresh.js, staleLaunchers): a launcher that points at this runner but records
// another digest, when the refresh did not rewrite it, gets one line saying to run `zn hooks install <agent>` again.
// Everything runs in a temporary home; refresh.main and staleLaunchers are called directly with that home, never the
// real postinstall script against the real HOME. Values are fake.

process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { getAdapter } = require('../lib/agents');
const refresh = require('../lib/agents/refresh');
const { tempDir } = require('./helpers/tmp');
const { hasPosixSh: posix } = require('./helpers/posix_sh');

const claude = getAdapter('claude-code');

function setup(t) {
  const home = tempDir(t, 'zn-stale-');
  const env = { HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), ZN_HOME: path.join(home, '.zn'), PATH: process.env.PATH };
  const runner = path.join(tempDir(t, 'zn-stale-pkg-'), 'runner.js');
  fs.writeFileSync(runner, 'process.exit(0);\n');
  claude.install({ env, home, nodePath: process.execPath, runnerPath: runner, mcp: false });
  return { home, env, runner };
}

test('stale notice: a launcher for this runner with another digest is reported', { skip: !posix }, (t) => {
  const ctx = setup(t);
  fs.writeFileSync(ctx.runner, 'process.exit(0); // other version\n');
  assert.deepEqual(refresh.staleLaunchers({ env: ctx.env, home: ctx.home, runnerPath: ctx.runner }), ['claude-code']);
});

test('stale notice: a launcher that points at another runner (project-local install) is not reported', { skip: !posix }, (t) => {
  const ctx = setup(t);
  const other = path.join(tempDir(t, 'zn-stale-other-'), 'runner.js');
  fs.writeFileSync(other, 'process.exit(0); // project copy\n');
  assert.deepEqual(refresh.staleLaunchers({ env: ctx.env, home: ctx.home, runnerPath: other }), []);
});

test('stale notice: nothing reported when the launcher matches the installed runner', { skip: !posix }, (t) => {
  const ctx = setup(t);
  assert.deepEqual(refresh.staleLaunchers({ env: ctx.env, home: ctx.home, runnerPath: ctx.runner }), []);
  let out = '';
  refresh.main({ env: ctx.env, home: ctx.home, runnerPath: ctx.runner, out: (s) => { out += s; }, err: () => {} });
  assert.equal(out, '');
});

test('stale notice: no launcher directory means nothing reported and no output', { skip: !posix }, (t) => {
  const home = tempDir(t, 'zn-stale-none-');
  const env = { HOME: home, ZN_HOME: path.join(home, '.zn') };
  const runner = path.join(home, 'runner.js');
  fs.writeFileSync(runner, 'process.exit(0);\n');
  assert.deepEqual(refresh.staleLaunchers({ env, home, runnerPath: runner }), []);
  let out = '';
  refresh.main({ env, home, runnerPath: runner, out: (s) => { out += s; } });
  assert.equal(out, '');
});

test('stale notice: a launcher that was refreshed gets the refreshed line, not the notice', { skip: !posix }, (t) => {
  const ctx = setup(t);
  fs.writeFileSync(ctx.runner, 'process.exit(0); // new\n');
  let out = '';
  refresh.main({ env: ctx.env, home: ctx.home, runnerPath: ctx.runner, out: (s) => { out += s; }, err: () => {} });
  assert.equal(out, 'zn-gate: refreshed hook launchers for claude-code\n');
});
