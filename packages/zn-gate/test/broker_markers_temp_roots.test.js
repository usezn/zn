'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const m = require('../lib/broker/markers');

test('tempRoots returns a non-empty list of absolute paths', () => {
  const roots = m.tempRoots();
  assert.ok(Array.isArray(roots));
  assert.ok(roots.length > 0);
  for (const r of roots) {
    assert.equal(typeof r, 'string');
    assert.ok(path.isAbsolute(r), r + ' is not absolute');
  }
});

test('tempRoots lists every folder only once', () => {
  const roots = m.tempRoots();
  assert.equal(new Set(roots).size, roots.length, 'duplicates in ' + roots.join(', '));
});

test('tempRoots includes the real path of os.tmpdir()', () => {
  const roots = m.tempRoots();
  const real = fs.realpathSync.native(os.tmpdir());
  const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  assert.ok(roots.map(norm).includes(norm(real)), real + ' not in ' + roots.join(', '));
});

test('on POSIX /tmp resolves to one of the temp folders', { skip: process.platform === 'win32' || !fs.existsSync('/tmp') }, () => {
  const roots = m.tempRoots();
  const real = fs.realpathSync.native('/tmp');
  assert.ok(roots.includes(real), real + ' not in ' + roots.join(', '));
});

test('tempRoots gives the same list when called twice', () => {
  assert.deepEqual(m.tempRoots(), m.tempRoots());
});
