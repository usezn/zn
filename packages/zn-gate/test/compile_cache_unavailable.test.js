'use strict';
// lib/compile-cache.js when the cache folder cannot be created: the cache is skipped, nothing throws.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { enable } = require('../lib/compile-cache');

const posix = process.platform !== 'win32';
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zn-cc-fail-'));
}

test('enable returns null when the parent folder is read-only', { skip: !posix || isRoot }, () => {
  const base = tmp();
  try {
    const parent = path.join(base, 'ro');
    fs.mkdirSync(parent);
    fs.chmodSync(parent, 0o500);
    const home = path.join(parent, 'zn-home');
    assert.strictEqual(enable({ ZN_HOME: home }), null);
    assert.strictEqual(fs.existsSync(home), false);
  } finally {
    fs.chmodSync(path.join(base, 'ro'), 0o700);
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('enable returns null when a file sits where the home folder should be', () => {
  const base = tmp();
  try {
    const home = path.join(base, 'zn-home');
    fs.writeFileSync(home, 'not a folder');
    assert.strictEqual(enable({ ZN_HOME: home }), null);
    assert.strictEqual(fs.readFileSync(home, 'utf8'), 'not a folder');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('enable returns null when a file sits where the cache folder should be', () => {
  const base = tmp();
  try {
    const home = path.join(base, 'zn-home');
    fs.mkdirSync(home, { mode: 0o700 });
    fs.writeFileSync(path.join(home, 'cache'), 'not a folder');
    assert.strictEqual(enable({ ZN_HOME: home }), null);
    assert.strictEqual(fs.readFileSync(path.join(home, 'cache'), 'utf8'), 'not a folder');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('enable returns null when a file sits where the compile folder should be', () => {
  const base = tmp();
  try {
    const cache = path.join(base, 'zn-home', 'cache');
    fs.mkdirSync(cache, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(cache, 'compile'), 'not a folder');
    assert.strictEqual(enable({ ZN_HOME: path.join(base, 'zn-home') }), null);
    assert.ok(fs.statSync(path.join(cache, 'compile')).isFile());
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
