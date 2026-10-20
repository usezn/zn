'use strict';
// Windows owner-only ACLs on the vault folders and files (B-328). Unit tests mock execFileSync and the platform;
// the integration test runs only on Windows and checks the real ACL with icacls.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');

const store = require('../lib/vault/store');

const SID = 'S-1-5-21-111-222-333-1001';
const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
const setPlatform = (p) => Object.defineProperty(process, 'platform', { value: p, configurable: true });

function fakeWindows(t, { icaclsFails = false } = {}) {
  setPlatform('win32');
  const calls = [];
  t.mock.method(childProcess, 'execFileSync', (exe, args) => {
    calls.push({ exe, args });
    if (/whoami/i.test(exe)) return '"HOST_user","' + SID + '"\r\n';
    if (icaclsFails) throw new Error('icacls: Access is denied.\nmore');
    return '';
  });
  const warnings = [];
  t.mock.method(process.stderr, 'write', (m) => { warnings.push(String(m)); return true; });
  t.after(() => Object.defineProperty(process, 'platform', realPlatform));
  return { calls, warnings, icacls: () => calls.filter((c) => /icacls/i.test(c.exe)) };
}

const tmpDir = (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-acl-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};

test('directory: inheritance removed, only the user SID granted, no shell', (t) => {
  const f = fakeWindows(t);
  const dir = path.join(tmpDir(t), 'a');
  store.ensurePrivateDir(dir);
  const [c] = f.icacls();
  assert.deepEqual(c.args, [dir, '/inheritance:r', '/grant:r', '*' + SID + ':(OI)(CI)F']);
  const who = f.calls.find((x) => /whoami/i.test(x.exe));
  assert.deepEqual(who.args, ['/user', '/fo', 'csv', '/nh']);
});

test('file: :F grant on the written file', (t) => {
  const f = fakeWindows(t);
  const dir = path.join(tmpDir(t), 'b');
  const file = path.join(dir, 'session.key');
  store.writePrivateFile(file, 'abc');
  const grants = f.icacls().map((c) => c.args);
  assert.ok(grants.some((a) => a[0] === dir && a[3] === '*' + SID + ':(OI)(CI)F'));
  const fileCall = grants.find((a) => a[0].startsWith(file + '.'));
  assert.ok(fileCall, 'the temp file is restricted before the rename');
  assert.deepEqual(fileCall.slice(1), ['/inheritance:r', '/grant:r', '*' + SID + ':F']);
  assert.equal(fs.readFileSync(file, 'utf8'), 'abc');
});

test('failure outside the user profile: refuses and writes nothing', (t) => {
  const f = fakeWindows(t, { icaclsFails: true });
  const dir = path.join(tmpDir(t), 'c'); // os.tmpdir() is outside the profile here
  t.mock.method(os, 'homedir', () => path.join(os.tmpdir(), 'zn-no-such-home-' + process.pid));
  const file = path.join(dir, 'session.key');
  assert.throws(() => store.writePrivateFile(file, 'secret'), /outside your user profile/);
  assert.equal(fs.existsSync(file), false);
  assert.ok(f.warnings.some((w) => /could not restrict/.test(w)));
});

test('failure inside the user profile: warns and goes on', (t) => {
  const f = fakeWindows(t, { icaclsFails: true });
  const base = tmpDir(t);
  t.mock.method(os, 'homedir', () => base);
  const file = path.join(base, '.zn', 'run', 'session.key');
  store.writePrivateFile(file, 'secret');
  assert.equal(fs.readFileSync(file, 'utf8'), 'secret');
  assert.ok(f.warnings.some((w) => /could not restrict/.test(w)));
});

test('POSIX: no icacls, modes unchanged', { skip: process.platform === 'win32' && 'POSIX modes' }, (t) => {
  const calls = [];
  t.mock.method(childProcess, 'execFileSync', (...a) => { calls.push(a); return ''; });
  const dir = path.join(tmpDir(t), 'p');
  const file = path.join(dir, 'k');
  store.writePrivateFile(file, 'x');
  assert.equal(calls.length, 0);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('Windows integration: only the current user can access ZN_HOME', { skip: process.platform !== 'win32' && 'needs Windows and icacls' }, (t) => {
  const home = path.join(tmpDir(t), 'zn-home');
  const p = store.ensureLayout({ home });
  const file = path.join(p.runDir, 'session.key');
  store.writePrivateFile(file, 'k');
  const sid = childProcess.execFileSync('whoami', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' }).match(/S-1-\d+(?:-\d+)+/)[0];
  for (const target of [p.home, p.vaultDir, p.runDir, file]) {
    const out = childProcess.execFileSync('icacls', [target], { encoding: 'utf8' });
    const aces = out.split(/\r?\n/).filter((l) => /:\(/.test(l) || /\(\w+(,\w+)*\)/.test(l));
    assert.ok(aces.length >= 1, 'has an ACE: ' + target);
    for (const l of aces) {
      assert.ok(!/Everyone|BUILTIN.Users|Authenticated Users|BUILTIN.Administrators|NT AUTHORITY.SYSTEM/i.test(l), 'no other principal on ' + target + ': ' + l);
    }
  }
  const who = childProcess.execFileSync('whoami', { encoding: 'utf8' }).trim().toLowerCase();
  const out = childProcess.execFileSync('icacls', [file], { encoding: 'utf8' }).toLowerCase();
  assert.ok(out.includes(who.slice(who.lastIndexOf(String.fromCharCode(92)) + 1)) || out.includes(sid.toLowerCase()), 'the user keeps access');
});
