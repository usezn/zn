'use strict';

// broker files: the path checks and the atomic write when the file system refuses an operation. Each case
// makes the failing call happen for real (no mocks): a folder where a file would go, a path that cannot be resolved.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempDir } = require('./helpers/tmp');
const files = require('../lib/broker/files');

test('nativeTargetOf keeps the path as typed when the Windows resolver refuses it', () => {
  const realpath = () => { throw Object.assign(new Error('access denied'), { code: 'EACCES' }); };
  const typed = path.resolve('some', 'project', 'file.txt');
  assert.equal(files.nativeTargetOf(typed, { platform: 'win32', realpath }), typed);
});

test('writeFileAtomic: a rename that fails leaves no temporary file behind and throws', (t) => {
  const dir = tempDir(t, 'zn-files-atomic-');
  // A folder where the file should go: the rename cannot replace it.
  const target = path.join(dir, 'occupied');
  fs.mkdirSync(target);
  assert.throws(() => files.writeFileAtomic(target, 'new content'));
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.zn-tmp')), []);
  assert.ok(fs.statSync(target).isDirectory(), 'the folder is still there');
});

test('writeFileAtomic writes the content and replaces an older file', { skip: process.platform === 'win32' && 'mode bits are not checked on Windows' }, (t) => {
  const dir = tempDir(t, 'zn-files-atomic-ok-');
  const target = path.join(dir, 'note.txt');
  fs.writeFileSync(target, 'old');
  files.writeFileAtomic(target, 'new', 0o600);
  assert.equal(fs.readFileSync(target, 'utf8'), 'new');
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(dir), ['note.txt']);
});
