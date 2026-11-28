'use strict';

// A protected-looking file that exists but cannot be opened is refused, like one that can be read and holds a key.
// Fake key text and temp folders only; nothing is executed.

process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const policy = require('../lib/hooks/policy');
const { tempDir } = require('./helpers/tmp');

const FAKE_KEY = '-----BEGIN PRIVATE KEY-----\nZm9yIHRlc3Rpbmcgb25seQ==\n-----END PRIVATE KEY-----\n';
const canChmod = process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() !== 0;

function project(t) {
  const dir = tempDir(t, 'zn-unread-');
  return { dir, o: { cwd: dir, home: dir, env: {} } };
}
function lockedFile(t, dir, name, body) {
  const f = path.join(dir, name);
  fs.writeFileSync(f, body);
  fs.chmodSync(f, 0o000);
  t.after(() => { try { fs.chmodSync(f, 0o600); } catch (_) { /* gone */ } });
}

test('a readable fake key is refused (baseline)', (t) => {
  const { dir, o } = project(t);
  fs.writeFileSync(path.join(dir, 'a.pem'), FAKE_KEY);
  assert.ok(policy.bashDenial('cat a.pem', o));
});

test('a key file with mode 000 is refused, with or without sudo', { skip: !canChmod }, (t) => {
  const { dir, o } = project(t);
  lockedFile(t, dir, 'b.pem', FAKE_KEY);
  for (const cmd of ['cat b.pem', 'sudo cat b.pem', 'cat ./b.pem']) {
    const d = policy.bashDenial(cmd, o);
    assert.ok(d, cmd);
    assert.match(d, /could not read this file to check it/);
  }
});

test('.key and .p8 files with mode 000 are refused', { skip: !canChmod }, (t) => {
  const { dir, o } = project(t);
  lockedFile(t, dir, 'c.key', FAKE_KEY);
  lockedFile(t, dir, 'd.p8', FAKE_KEY);
  assert.ok(policy.bashDenial('cat c.key', o));
  assert.ok(policy.bashDenial('cat d.p8', o));
});

test('an unreadable .env is refused', { skip: !canChmod }, (t) => {
  const { dir, o } = project(t);
  lockedFile(t, dir, '.env', 'EXAMPLE_API_KEY=zn-test-fake-value-0000\n');
  const d = policy.bashDenial('cat .env', o);
  assert.ok(d);
  assert.match(d, /could not read this file to check it/);
});

test('an unreadable key file matched by a glob is refused', { skip: !canChmod }, (t) => {
  const { dir, o } = project(t);
  lockedFile(t, dir, 'e.pem', FAKE_KEY);
  assert.ok(policy.bashDenial('cat *.pem', o));
});

test('a symlink loop named like a key file is refused', { skip: process.platform === 'win32' }, (t) => {
  const { dir, o } = project(t);
  fs.symlinkSync('loop2.pem', path.join(dir, 'loop1.pem'));
  fs.symlinkSync('loop1.pem', path.join(dir, 'loop2.pem'));
  assert.ok(policy.bashDenial('cat loop1.pem', o));
});

test('running out of file descriptors is refused (open stubbed)', (t) => {
  const { dir, o } = project(t);
  fs.writeFileSync(path.join(dir, 'f.pem'), FAKE_KEY);
  fs.writeFileSync(path.join(dir, '.env'), 'EXAMPLE_API_KEY=zn-test-fake-value-0000\n');
  const real = fs.openSync;
  fs.openSync = (p, ...rest) => {
    if (/(\.pem|\.env)$/.test(String(p))) throw Object.assign(new Error('too many open files'), { code: 'EMFILE' });
    return real.call(fs, p, ...rest);
  };
  t.after(() => { fs.openSync = real; });
  assert.ok(policy.bashDenial('cat f.pem', o));
  assert.ok(policy.bashDenial('cat .env', o));
});

test('a missing file and a harmless readable file keep their verdicts', (t) => {
  const { dir, o } = project(t);
  fs.writeFileSync(path.join(dir, 'cert.pem'), '-----BEGIN CERTIFICATE-----\nZm9y\n-----END CERTIFICATE-----\n');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'hello\n');
  assert.equal(policy.bashDenial('cat missing.pem', o), null);
  assert.equal(policy.bashDenial('cat missing/.env', o), null);
  assert.equal(policy.bashDenial('cat cert.pem', o), null);
  assert.equal(policy.bashDenial('cat notes.txt', o), null);
});
