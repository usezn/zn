'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const m = require('../lib/broker/markers');

test('findMarkers returns an empty list for text without a marker prefix', () => {
  assert.deepEqual(m.findMarkers('plain text with GITHUB_TOKEN and ZN_X'), []);
  assert.deepEqual(m.findMarkers(''), []);
});

test('findMarkers lists a marker used twice once', () => {
  const found = m.findMarkers('a __ZN_DB_URL__ b __ZN_DB_URL__ c');
  assert.deepEqual(found, [{ marker: '__ZN_DB_URL__', name: 'DB_URL', detected: false }]);
});

test('substitute leaves an unknown name as written', () => {
  const values = new Map([['KNOWN', 'fake-value']]);
  assert.equal(m.substitute('x __ZN_UNKNOWN__ y', values), 'x __ZN_UNKNOWN__ y');
  assert.equal(m.substitute('__ZN_KNOWN__ __ZN_UNKNOWN__', values), 'fake-value __ZN_UNKNOWN__');
});

test('isInside separates /proj from /proj2 and a parent from a child', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-inside-'));
  try {
    const proj = path.join(root, 'proj');
    const proj2 = path.join(root, 'proj2');
    const child = path.join(proj, 'src', 'a.js');
    assert.equal(m.isInside(proj2, proj), false);
    assert.equal(m.isInside(proj, proj2), false);
    assert.equal(m.isInside(child, proj), true);
    assert.equal(m.isInside(proj, child), false);
    assert.equal(m.isInside(proj, proj), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
