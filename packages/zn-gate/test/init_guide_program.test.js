'use strict';

// findProgram and spawnProgram (the child environment) of lib/init-guide.js, in temporary folders.

process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { _internal } = require('../lib/init-guide');
const { tempDir } = require('./helpers/tmp');

const isWin = process.platform === 'win32';
const progName = (n) => (isWin ? n + '.cmd' : n);

test('findProgram: a program on a fake PATH is found by its absolute path', (t) => {
  const dir = tempDir(t, 'zn-prog-bin-');
  fs.writeFileSync(path.join(dir, progName('zn-fake-tool')), '');
  assert.equal(_internal.findProgram('zn-fake-tool', { PATH: dir }), path.join(dir, progName('zn-fake-tool')));
});

test('findProgram: the first PATH entry that has the program wins', (t) => {
  const first = tempDir(t, 'zn-prog-first-');
  const second = tempDir(t, 'zn-prog-second-');
  fs.writeFileSync(path.join(first, progName('zn-fake-tool')), '');
  fs.writeFileSync(path.join(second, progName('zn-fake-tool')), '');
  const env = { PATH: [first, second].join(path.delimiter) };
  assert.equal(_internal.findProgram('zn-fake-tool', env), path.join(first, progName('zn-fake-tool')));
});

test('findProgram: a missing program gives null, also with an empty or missing PATH', (t) => {
  const dir = tempDir(t, 'zn-prog-empty-');
  assert.equal(_internal.findProgram('zn-fake-tool', { PATH: dir }), null);
  assert.equal(_internal.findProgram('zn-fake-tool', { PATH: path.join(dir, 'absent') }), null);
  assert.equal(_internal.findProgram('zn-fake-tool', { PATH: '' }), null);
  assert.equal(_internal.findProgram('zn-fake-tool', {}), null);
});

test('findProgram: a folder name with spaces works', (t) => {
  const base = tempDir(t, 'zn-prog-space-');
  const dir = path.join(base, 'my tools', 'bin dir');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, progName('zn-fake-tool')), '');
  assert.equal(_internal.findProgram('zn-fake-tool', { PATH: dir }), path.join(dir, progName('zn-fake-tool')));
});

test('spawnProgram: the child gets exactly the environment it is given, no extra keys', { skip: isWin }, (t) => {
  const env = { ZN_FAKE_ONE: 'one', ZN_FAKE_TWO: 'two' };
  const r = _internal.spawnProgram(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.env))'], env, { encoding: 'utf8' });
  assert.equal(r.status, 0);
  const seen = JSON.parse(r.stdout);
  for (const k of Object.keys(env)) assert.equal(seen[k], env[k]);
  // The runtime itself may add a few variables of its own; none of the zn ones or the parent's may appear.
  assert.equal(seen.ZN_STATS, undefined);
  assert.equal(seen.HOME, undefined);
  assert.deepEqual(Object.keys(env).sort(), Object.keys(seen).filter((k) => k.startsWith('ZN_FAKE')).sort());
});

test('spawnProgram: the given environment object is not modified', (t) => {
  const env = { ZN_FAKE_ONE: 'one' };
  _internal.spawnProgram(process.execPath, ['-e', ''], env, {});
  assert.deepEqual(env, { ZN_FAKE_ONE: 'one' });
});
