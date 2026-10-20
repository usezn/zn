'use strict';
// readPrivateFile: loose POSIX modes are tightened, or refused when that fails.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../lib/vault/store');

const posix = process.platform !== 'win32';

function fixture(t, mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-modes-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const run = path.join(dir, 'run');
  fs.mkdirSync(run, { mode: 0o700 });
  const file = path.join(run, 'session.key');
  fs.writeFileSync(file, 'k');
  fs.chmodSync(file, mode);
  return { run, file };
}

function quiet(t) {
  const lines = [];
  t.mock.method(process.stderr, 'write', (s) => { lines.push(String(s)); return true; });
  return lines;
}

test('a 0644 key is re-tightened to 0600 and read, with a warning', { skip: !posix }, (t) => {
  const { file } = fixture(t, 0o644);
  const lines = quiet(t);
  assert.equal(store.readPrivateFile(file).toString(), 'k');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.ok(lines.some((l) => l.includes(file) && l.includes('644')));
});

test('a key whose chmod fails is refused with the fix in the message', { skip: !posix }, (t) => {
  const { file } = fixture(t, 0o640);
  const real = fs.chmodSync;
  t.mock.method(fs, 'chmodSync', (f, m) => {
    if (f === file) throw new Error('EPERM: operation not permitted');
    return real(f, m);
  });
  assert.throws(() => store.readPrivateFile(file), (err) =>
    err.message.includes(file) && err.message.includes('chmod 600'));
});

test('a 0600 key is left alone and silent', { skip: !posix }, (t) => {
  const { file } = fixture(t, 0o600);
  const lines = quiet(t);
  assert.equal(store.readPrivateFile(file).toString(), 'k');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(lines.length, 0);
});

test('a loose run dir is closed to 0700 on read', { skip: !posix }, (t) => {
  const { run, file } = fixture(t, 0o600);
  fs.chmodSync(run, 0o755);
  store.readPrivateFile(file);
  assert.equal(fs.statSync(run).mode & 0o777, 0o700);
});
