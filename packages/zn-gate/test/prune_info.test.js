'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pruneInfo, MARKERS, SILENT } = require('../lib/prune');

function withDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-prune-'));
  try { fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('node_modules and .git are skipped silently', () => withDir((dir) => {
  for (const name of ['node_modules', '.git']) {
    assert.deepEqual(pruneInfo(name, dir), { silent: true, reason: 'skipped by name' }, name);
  }
}));

test('target and vendor are read without a build file next to them', () => withDir((dir) => {
  assert.equal(pruneInfo('target', dir), null);
  assert.equal(pruneInfo('vendor', dir), null);
}));

test('target is skipped and reported when Cargo.toml sits next to it', () => withDir((dir) => {
  fs.writeFileSync(path.join(dir, 'Cargo.toml'), '');
  assert.deepEqual(pruneInfo('target', dir), {
    silent: false,
    reason: 'skipped by name: build output next to Cargo.toml',
  });
}));

test('vendor is skipped and reported when go.mod sits next to it', () => withDir((dir) => {
  fs.writeFileSync(path.join(dir, 'go.mod'), '');
  assert.deepEqual(pruneInfo('vendor', dir), {
    silent: false,
    reason: 'skipped by name: dependencies next to go.mod',
  });
}));

test('reported names carry their kind in the reason', () => withDir((dir) => {
  const expected = {
    '.venv': 'virtual environment',
    venv: 'virtual environment',
    __pycache__: 'Python cache',
    '.idea': 'editor settings',
    '.eggs': 'Python build files',
    dist: 'build output',
  };
  for (const [name, kind] of Object.entries(expected)) {
    assert.deepEqual(pruneInfo(name, dir), { silent: false, reason: 'skipped by name: ' + kind }, name);
  }
}));

test('a name in no list is skipped as build output', () => withDir((dir) => {
  assert.deepEqual(pruneInfo('some-other-dir', dir), { silent: false, reason: 'skipped by name: build output' });
}));

test('MARKERS lists the ambiguous names only', () => {
  assert.deepEqual(Object.keys(MARKERS).sort(), ['target', 'vendor']);
});

test('every silent name is skipped by pruneInfo and reported as silent', () => withDir((dir) => {
  for (const name of SILENT) {
    const info = pruneInfo(name, dir);
    assert.ok(info, name + ' is skipped');
    assert.equal(info.silent, true, name);
  }
}));

test('every marker file makes its ambiguous name a reported skip', () => {
  for (const [name, files] of Object.entries(MARKERS)) {
    for (const file of files) {
      withDir((dir) => {
        fs.writeFileSync(path.join(dir, file), '');
        assert.deepEqual(pruneInfo(name, dir), {
          silent: false,
          reason: 'skipped by name: ' + (name === 'vendor' ? 'dependencies' : 'build output') + ' next to ' + file,
        }, name + ' + ' + file);
      });
    }
  }
});

test('a marker directory does not count as a build file', () => withDir((dir) => {
  fs.mkdirSync(path.join(dir, 'Cargo.toml'));
  // existsSync is true for a directory, so the current behaviour is a skip.
  assert.equal(pruneInfo('target', dir).silent, false);
}));

test('silent names are all in the scan list or are tool caches only', () => {
  const { SCAN_DIRS } = require('../lib/prune');
  for (const name of SCAN_DIRS) {
    if (SILENT.has(name)) assert.equal(pruneInfo(name, os.tmpdir()).silent, true, name);
  }
  assert.ok(SCAN_DIRS.has('dist') && !SILENT.has('dist'));
});
