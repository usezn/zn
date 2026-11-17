'use strict';
/*
 * A save that is killed halfway must not leave encrypted snapshots behind, must be made durable
 * with a directory sync, and the log must say that a recorded change may not have been applied.
 * Fake values only; every test uses its own temporary ZN_HOME.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tempDir } = require('./helpers/tmp');

const store = require('../lib/vault/store');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
const HEX = 'a1b2c3d4e5f6';

function deadPid() {
  // A process that has already exited: its pid is not alive.
  const r = spawnSync(process.execPath, ['-e', '0']);
  return r.pid;
}

function setup(t) {
  const dir = tempDir(t, 'zn-orphan-');
  fs.chmodSync(dir, 0o700);
  return dir;
}

function put(dir, name, ageMs) {
  const f = path.join(dir, name);
  fs.writeFileSync(f, 'ciphertext-placeholder', { mode: 0o600 });
  if (ageMs) {
    const when = new Date(Date.now() - ageMs);
    fs.utimesSync(f, when, when);
  }
  return f;
}

test('cleanupOrphanTmp removes an orphan of a dead process and keeps everything else', (t) => {
  const dir = setup(t);
  const dead = put(dir, 'secrets.age.' + deadPid() + '.' + HEX + '.tmp');
  const live = put(dir, 'secrets.age.' + process.pid + '.' + HEX + '.tmp');
  const liveOld = put(dir, 'identity.age.' + process.pid + '.' + HEX + '.tmp', 10 * 60 * 1000);
  const real = put(dir, 'secrets.age');
  const foreign = [
    put(dir, 'notes.tmp'),
    put(dir, 'secrets.age.tmp'),
    put(dir, 'secrets.age.' + deadPid() + '.nothex.tmp'),
    put(dir, 'secrets.age.' + deadPid() + '.' + HEX + '.tmp.bak'),
    put(dir, 'keychain.json'),
  ];
  const n = store.cleanupOrphanTmp(dir);
  assert.strictEqual(n, 2);
  assert.ok(!fs.existsSync(dead), 'dead-pid orphan removed');
  assert.ok(!fs.existsSync(liveOld), 'old file removed even if the pid is alive');
  assert.ok(fs.existsSync(live), 'young file of a live pid kept');
  assert.ok(fs.existsSync(real));
  for (const f of foreign) assert.ok(fs.existsSync(f), 'kept: ' + f);
});

test('cleanupOrphanTmp with a target name only touches that target', (t) => {
  const dir = setup(t);
  const pid = deadPid();
  const a = put(dir, 'secrets.age.' + pid + '.' + HEX + '.tmp');
  const b = put(dir, 'identity.age.' + pid + '.' + HEX + '.tmp');
  assert.strictEqual(store.cleanupOrphanTmp(dir, 'secrets.age'), 1);
  assert.ok(!fs.existsSync(a));
  assert.ok(fs.existsSync(b));
});

test('cleanupOrphanTmp does not follow or remove a directory or symlink with the same name', (t) => {
  const dir = setup(t);
  const pid = deadPid();
  const d = path.join(dir, 'secrets.age.' + pid + '.' + HEX + '.tmp');
  fs.mkdirSync(d);
  assert.strictEqual(store.cleanupOrphanTmp(dir), 0);
  assert.ok(fs.existsSync(d));
  const outside = put(dir, 'outside-target');
  const link = path.join(dir, 'secrets.age.' + pid + '.' + 'f'.repeat(12) + '.tmp');
  try { fs.symlinkSync(outside, link); } catch (e) { return; }
  assert.strictEqual(store.cleanupOrphanTmp(dir), 0);
  assert.ok(fs.existsSync(outside));
});

test('ensureLayout removes an orphan in the vault directory', (t) => {
  const home = tempDir(t, 'zn-orphan-home-');
  const opts = { home };
  const p = store.ensureLayout(opts);
  const orphan = put(p.vaultDir, 'secrets.age.' + deadPid() + '.' + HEX + '.tmp');
  store.ensureLayout(opts);
  assert.ok(!fs.existsSync(orphan));
});

test('writePrivateFile removes an orphan of its own target before writing', (t) => {
  const dir = setup(t);
  const orphan = put(dir, 'secrets.age.' + deadPid() + '.' + HEX + '.tmp');
  const other = put(dir, 'other.age.' + deadPid() + '.' + HEX + '.tmp');
  store.writePrivateFile(path.join(dir, 'secrets.age'), Buffer.from('x'));
  assert.ok(!fs.existsSync(orphan));
  assert.ok(fs.existsSync(other), 'another target is left to ensureLayout');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'secrets.age'), 'utf8'), 'x');
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(path.join(dir, 'secrets.age')).mode & 0o777, 0o600);
});

test('writePrivateFile syncs the directory after the rename (POSIX)', { skip: process.platform === 'win32' }, (t) => {
  const dir = setup(t);
  const calls = [];
  const orig = { openSync: fs.openSync, fsyncSync: fs.fsyncSync, renameSync: fs.renameSync };
  const dirFds = new Set();
  fs.renameSync = (...a) => { calls.push('rename'); return orig.renameSync(...a); };
  fs.openSync = (...a) => {
    const fd = orig.openSync(...a);
    if (a[0] === dir) { calls.push('open-dir'); dirFds.add(fd); }
    return fd;
  };
  fs.fsyncSync = (fd, ...a) => { calls.push(dirFds.has(fd) ? 'fsync-dir' : 'fsync-file'); return orig.fsyncSync(fd, ...a); };
  try {
    store.writePrivateFile(path.join(dir, 'secrets.age'), Buffer.from('x'));
  } finally {
    Object.assign(fs, orig);
  }
  assert.deepStrictEqual(calls.filter((c) => c !== 'open-dir'), ['fsync-file', 'rename', 'fsync-dir']);
});

test('fsyncDir ignores platforms that cannot sync a directory', { skip: process.platform === 'win32' }, (t) => {
  const dir = setup(t);
  const orig = fs.fsyncSync;
  fs.fsyncSync = () => { const e = new Error('nope'); e.code = 'EINVAL'; throw e; };
  try {
    assert.doesNotThrow(() => store.fsyncDir(dir));
  } finally {
    fs.fsyncSync = orig;
  }
  fs.fsyncSync = () => { const e = new Error('disk'); e.code = 'EIO'; throw e; };
  try {
    assert.throws(() => store.fsyncDir(dir), /disk/);
  } finally {
    fs.fsyncSync = orig;
  }
});

test('zn vault log tells that the last recorded changes may not have been applied', (t) => {
  const home = tempDir(t, 'zn-audit-');
  fs.mkdirSync(path.join(home, '.zn'), { recursive: true });
  const base = { ts: '2026-01-01T00:00:00.000Z', decision: 'warn', secret: null, mode: 'unlock', prev: '0', mac: '00' };
  const recs = [
    { ...base, seq: 1, reason: 'audit_tail_adopted_after_unclean_shutdown:3' },
    { ...base, seq: 2, decision: 'allow', reason: 'ttl:60m' },
  ];
  fs.writeFileSync(path.join(home, '.zn', 'audit.jsonl'), recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const env = { ...process.env, HOME: home, USERPROFILE: home, ZN_HOME: path.join(home, '.zn') };
  const r = spawnSync(process.execPath, [CLI, 'vault', 'log'], { env, encoding: 'utf8', timeout: 30000 });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /The last 3 recorded changes may not have been applied; check with `[^`]*secret list`/);
  assert.strictEqual((r.stdout.match(/may not have been applied/g) || []).length, 1);
});
