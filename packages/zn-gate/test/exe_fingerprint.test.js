'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fingerprint, fingerprintOf, describeFingerprint, openExecutable, verifyOpen } = require('../lib/exe');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-exe-fp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function closeQuietly(fd) {
  try { fs.closeSync(fd); } catch (_) { /* already closed */ }
}

test('fingerprintOf: the same file gives the same fingerprint twice', (t) => {
  const file = path.join(tempDir(t), 'tool');
  fs.writeFileSync(file, 'one');
  assert.equal(fingerprintOf(fs.statSync(file)), fingerprintOf(fs.statSync(file)));
  assert.equal(fingerprint(file), fingerprintOf(fs.statSync(file)));
});

test('fingerprintOf: has four colon separated parts and the file size', (t) => {
  const file = path.join(tempDir(t), 'tool');
  fs.writeFileSync(file, 'abcde');
  const parts = fingerprintOf(fs.statSync(file)).split(':');
  assert.equal(parts.length, 4);
  assert.equal(parts[2], '5');
});

test('fingerprintOf: a file with different content size differs', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'tool');
  fs.writeFileSync(file, 'short');
  const before = fingerprint(file);
  fs.writeFileSync(file, 'a much longer content');
  assert.notEqual(fingerprint(file), before);
});

test('fingerprintOf: a file replaced by another one at the same path differs', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'tool');
  const other = path.join(dir, 'other');
  fs.writeFileSync(file, 'same');
  const before = fingerprint(file);
  fs.writeFileSync(other, 'same');
  fs.renameSync(other, file);
  assert.notEqual(fingerprint(file), before);
});

test('fingerprint: a missing file or a directory gives null', (t) => {
  const dir = tempDir(t);
  assert.equal(fingerprint(path.join(dir, 'missing')), null);
  assert.equal(fingerprint(dir), null);
});

test('describeFingerprint: reads size and change time from a fingerprint', () => {
  assert.deepEqual(describeFingerprint('1:2:300:1700000000000'), { size: 300, changed: '2023-11-14T22:13:20Z' });
});

test('describeFingerprint: round trips a real fingerprint', (t) => {
  const file = path.join(tempDir(t), 'tool');
  fs.writeFileSync(file, 'abc');
  const d = describeFingerprint(fingerprint(file));
  assert.equal(d.size, 3);
  assert.match(d.changed, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
});

test('describeFingerprint: anything but four parts gives null', () => {
  assert.equal(describeFingerprint(null), null);
  assert.equal(describeFingerprint(undefined), null);
  assert.equal(describeFingerprint(''), null);
  assert.equal(describeFingerprint('1:2:3'), null);
  assert.equal(describeFingerprint('1:2:3:4:5'), null);
});

test('describeFingerprint: non numeric size or time gives null fields', () => {
  assert.deepEqual(describeFingerprint('1:2:big:late'), { size: null, changed: null });
});

test('openExecutable: fingerprint of the open file matches the path', (t) => {
  const file = path.join(tempDir(t), 'tool');
  fs.writeFileSync(file, 'plain text');
  const opened = openExecutable(file);
  t.after(() => closeQuietly(opened.fd));
  assert.equal(opened.fp, fingerprint(file));
  assert.equal(opened.elf, false);
});

test('openExecutable: recognises the ELF magic on Linux', (t) => {
  const file = path.join(tempDir(t), 'tool');
  fs.writeFileSync(file, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0, 0]));
  const opened = openExecutable(file);
  t.after(() => closeQuietly(opened.fd));
  assert.equal(opened.elf, process.platform === 'linux');
});

test('openExecutable: a file shorter than four bytes is not ELF', (t) => {
  const file = path.join(tempDir(t), 'tool');
  fs.writeFileSync(file, 'ab');
  const opened = openExecutable(file);
  t.after(() => closeQuietly(opened.fd));
  assert.equal(opened.elf, false);
});

test('openExecutable: a missing file throws a plain ENOENT error', (t) => {
  const file = path.join(tempDir(t), 'missing');
  assert.throws(() => openExecutable(file), { code: 'ENOENT' });
});

test('openExecutable: a directory is refused', { skip: process.platform === 'win32' }, (t) => {
  assert.throws(() => openExecutable(tempDir(t)), (err) => err instanceof Error);
});

test('verifyOpen: an untouched file passes', (t) => {
  const file = path.join(tempDir(t), 'tool');
  fs.writeFileSync(file, 'content');
  const opened = openExecutable(file);
  t.after(() => closeQuietly(opened.fd));
  assert.equal(verifyOpen(opened, file, opened.fp), null);
});

test('verifyOpen: a different expected fingerprint reports a change', (t) => {
  const file = path.join(tempDir(t), 'tool');
  fs.writeFileSync(file, 'content');
  const opened = openExecutable(file);
  t.after(() => closeQuietly(opened.fd));
  assert.equal(verifyOpen(opened, file, '0:0:0:0'), 'the program changed after it was checked');
});

test('verifyOpen: a file rewritten after it was opened reports a change', (t) => {
  const file = path.join(tempDir(t), 'tool');
  fs.writeFileSync(file, 'content');
  const opened = openExecutable(file);
  t.after(() => closeQuietly(opened.fd));
  fs.writeFileSync(file, 'content that is now much longer');
  assert.equal(verifyOpen(opened, file, opened.fp), 'the program changed after it was checked');
});

test('verifyOpen: a path swapped for another file reports a different file', { skip: process.platform === 'win32' }, (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'tool');
  const other = path.join(dir, 'other');
  fs.writeFileSync(file, 'content');
  const opened = openExecutable(file);
  t.after(() => closeQuietly(opened.fd));
  fs.writeFileSync(other, 'content');
  fs.renameSync(other, file);
  // Unlinking also touches the old file's ctime, so which of the two reasons
  // is reported depends on the clock; either way the check must fail.
  assert.match(verifyOpen(opened, file, opened.fp), /^the (path now leads to a different file|program changed after it was checked)$/);
});

test('verifyOpen: a path that disappeared reports a different file', { skip: process.platform === 'win32' }, (t) => {
  const file = path.join(tempDir(t), 'tool');
  fs.writeFileSync(file, 'content');
  const opened = openExecutable(file);
  t.after(() => closeQuietly(opened.fd));
  fs.unlinkSync(file);
  // Unlinking also touches the old file's ctime, so which of the two reasons
  // is reported depends on the clock; either way the check must fail.
  assert.match(verifyOpen(opened, file, opened.fp), /^the (path now leads to a different file|program changed after it was checked)$/);
});

test('verifyOpen: a closed descriptor gives a plain result', (t) => {
  const file = path.join(tempDir(t), 'tool');
  fs.writeFileSync(file, 'content');
  const opened = openExecutable(file);
  fs.closeSync(opened.fd);
  assert.equal(verifyOpen(opened, file, opened.fp), 'the program could not be checked');
});
