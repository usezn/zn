'use strict';
// refresh.main(): what it prints through the `out` function, and that it never throws.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const launcher = require('../lib/agents/launcher');
const refresh = require('../lib/agents/refresh');
const { tempDir } = require('./helpers/tmp');

const posix = process.platform !== 'win32';
const RUNNER = "process.exit(0);\n";

function setup(t, ids) {
  const home = tempDir(t, 'zn-refresh-out-');
  const env = { HOME: home, ZN_HOME: path.join(home, '.zn') };
  const runner = path.join(tempDir(t, 'zn-refresh-out-pkg-'), 'runner.js');
  fs.writeFileSync(runner, RUNNER);
  // Launchers written with an old digest, so each one needs a refresh.
  for (const id of ids) {
    launcher.writeLauncher(id, process.execPath, runner, { env, home, runnerDigest: '00'.repeat(32) });
  }
  return { home, env, runner };
}

function run(ctx, extra = {}) {
  const calls = [];
  refresh.main({ env: ctx.env, home: ctx.home, runnerPath: ctx.runner, out: (s) => calls.push(s), ...extra });
  return calls;
}

test('refresh main: one line names every refreshed agent, in order', { skip: !posix && 'a Windows install has no sh launcher (its PowerShell hook is covered by the windows tests)' }, (t) => {
  const ctx = setup(t, ['codex', 'claude-code']);
  const calls = run(ctx);
  assert.deepEqual(calls, ['zn-gate: refreshed hook launchers for claude-code, codex\n']);
});

test('refresh main: nothing refreshed means out is never called', { skip: !posix && 'a Windows install has no sh launcher (its PowerShell hook is covered by the windows tests)' }, (t) => {
  const ctx = setup(t, ['claude-code']);
  assert.equal(run(ctx).length, 1);
  assert.deepEqual(run(ctx), []);
});

test('refresh main: no launchers at all means out is never called', { skip: !posix && 'a Windows install has no sh launcher (its PowerShell hook is covered by the windows tests)' }, (t) => {
  assert.deepEqual(run(setup(t, [])), []);
});

test('refresh main: a failing out function does not make main throw', { skip: !posix && 'a Windows install has no sh launcher (its PowerShell hook is covered by the windows tests)' }, (t) => {
  const ctx = setup(t, ['claude-code']);
  assert.doesNotThrow(() => run(ctx, { out: () => { throw new Error('closed pipe'); } }));
});

test('refresh main: a failing refresh does not throw and prints nothing', () => {
  const calls = [];
  const opts = { out: (s) => calls.push(s) };
  Object.defineProperty(opts, 'env', { get() { throw new Error('broken environment'); } });
  assert.doesNotThrow(() => refresh.main(opts));
  assert.deepEqual(calls, []);
});

test('refresh main: a missing launcher directory does not throw', () => {
  assert.doesNotThrow(() => refresh.main({ env: { ZN_HOME: '/nonexistent/zn-home.invalid' }, home: '/nonexistent/home.invalid', out: () => {} }));
});
