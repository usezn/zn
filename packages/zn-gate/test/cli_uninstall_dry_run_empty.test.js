'use strict';

// bin/cli.js uninstall in an empty temporary home: --dry-run says there is nothing to remove,
// exits 0 and asks nothing; an option it does not know exits 64 with a plain message.

process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');
const { tempDir } = require('./helpers/tmp');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');

function run(t, args) {
  const home = tempDir(t, 'zn-uninst-empty-home-');
  const cwd = tempDir(t, 'zn-uninst-empty-cwd-');
  const env = { HOME: home, USERPROFILE: home, PATH: process.env.PATH };
  return spawnSync(process.execPath, [CLI, 'uninstall', ...args], {
    env, cwd, input: '', encoding: 'utf8', timeout: 60000,
  });
}

test('uninstall --dry-run in an empty home says nothing was found and exits 0', (t) => {
  const r = run(t, ['--dry-run']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Nothing from zn-gate was found/);
  assert.equal(r.stderr, '');
});

test('uninstall --dry-run in an empty home asks no question', (t) => {
  const r = run(t, ['--dry-run']);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout + r.stderr, /\[y\/N\]|Remove everything|Delete the vault|\?\s*$/m);
});

test('uninstall with an unknown option exits 64 with a plain message', (t) => {
  const r = run(t, ['--bogus']);
  assert.equal(r.status, 64);
  assert.match(r.stderr, /unknown option --bogus/);
  assert.match(r.stderr, /usage: zn-gate uninstall \[--dry-run\]/);
  assert.doesNotMatch(r.stderr, /\n\s+at /, 'no stack trace');
  assert.equal(r.stdout, '');
});

test('uninstall --dry-run with an unknown option still exits 64', (t) => {
  const r = run(t, ['--dry-run', '--bogus']);
  assert.equal(r.status, 64);
  assert.match(r.stderr, /unknown option --bogus/);
});
