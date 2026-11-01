'use strict';
process.env.ZN_STATS = 'off';

// A full disk while a file is written names that file in plain words, and a failed write leaves no temporary file
// behind. A read-only or unusable temporary folder makes `check` name TMPDIR. Errors are simulated: no real disk is filled.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { fsErrorText, fsReason } = require('../lib/errors');
const { writeFileAtomic } = require('../lib/broker/files');
const cloudKey = require('../lib/cloud-key');
const check = require('../lib/check');

function enospc(p) {
  return Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC', errno: -28, syscall: 'write', path: p });
}

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-disk-msg-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('fsReason gives a few plain words per disk error and nothing for other errors', () => {
  assert.equal(fsReason(enospc('/x')), 'the disk is full');
  assert.equal(fsReason(Object.assign(new Error('x'), { code: 'EROFS' })), 'the disk is read-only');
  assert.equal(fsReason(Object.assign(new Error('x'), { code: 'EACCES' })), 'your account is not allowed to write it');
  assert.equal(fsReason(new Error('plain')), null);
});

test('a copy that fails names its destination, not the source', () => {
  const err = Object.assign(enospc('/home/example-user/.claude/settings.json'), { dest: '/home/example-user/.claude/settings.json.bak-zn-1' });
  const shown = Object.assign({}, err, { path: err.dest });
  assert.equal(fsErrorText(shown, null, {}, 'linux'), 'The disk that holds /home/example-user/.claude/settings.json.bak-zn-1 is full. Free some space, then try again.');
});

test('writeFileAtomic: a full disk names the real file, and no temporary file stays behind', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, 'old\n');
  t.mock.method(fs, 'writeFileSync', function () { throw enospc('x'); });
  let caught = null;
  try { writeFileAtomic(file, 'new\n', 0o600); } catch (e) { caught = e; }
  assert.ok(caught, 'the write must fail');
  assert.equal(caught.path, file);
  assert.equal(fsErrorText(caught, null, {}, 'linux'), 'The disk that holds ' + file + ' is full. Free some space, then try again.');
  assert.deepEqual(fs.readdirSync(dir), ['settings.json'], 'the temporary file must be removed');
  assert.equal(fs.readFileSync(file, 'utf8'), 'old\n');
});

test('zn config: a failed write removes the temporary file and keeps config.json as it was', (t) => {
  const home = tmpDir(t);
  const zn = path.join(home, '.zn');
  fs.mkdirSync(zn);
  const file = path.join(zn, 'config.json');
  const before = '{"cloud":{"store":"keychain","connectedAt":"2026-11-01T00:00:00.000Z","last4":"abcd"}}\n';
  fs.writeFileSync(file, before);
  const prev = process.env.ZN_HOME;
  process.env.ZN_HOME = zn;
  t.after(() => { if (prev === undefined) delete process.env.ZN_HOME; else process.env.ZN_HOME = prev; });
  t.mock.method(fs, 'writeSync', function () { throw enospc('x'); });
  let caught = null;
  try { cloudKey.forgetMarker(); } catch (e) { caught = e; }
  assert.ok(caught, 'the write must fail');
  assert.equal(caught.path, file);
  assert.deepEqual(fs.readdirSync(zn), ['config.json'], 'no config.json.<pid>.tmp may stay behind');
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('check: a read-only temporary folder is named, with the TMPDIR variable and no template name', async (t) => {
  const err = Object.assign(new Error('EROFS: read-only file system, mkdtemp'), { code: 'EROFS', errno: -30 });
  t.mock.method(fs, 'mkdtempSync', function () { throw err; });
  const prev = process.env.TMPDIR;
  process.env.TMPDIR = '/workspace/ro';
  t.after(() => { if (prev === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = prev; });
  await assert.rejects(check.check({ home: os.tmpdir(), cwd: os.tmpdir() }), (e) => {
    assert.match(e.message, /^zn-gate check cannot use the temporary folder \/workspace\/ro: the disk is read-only\. Set TMPDIR \(TEMP on Windows\) to a folder you can write, for example TMPDIR=\/workspace\/tmp, then run check again\.$/);
    assert.doesNotMatch(e.message, /XXXXXX|read-only disk\.$/);
    return true;
  });
});

test('check: a temporary folder that is a file (not a folder) is named too', { skip: process.platform === 'win32' }, async (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'not-a-folder');
  fs.writeFileSync(file, 'x');
  const prev = process.env.TMPDIR;
  process.env.TMPDIR = file;
  t.after(() => { if (prev === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = prev; });
  await assert.rejects(check.check({ home: dir, cwd: dir }), (e) => {
    assert.match(e.message, /^zn-gate check cannot use the temporary folder .*not-a-folder: it cannot be written to\. Set TMPDIR/);
    return true;
  });
});
