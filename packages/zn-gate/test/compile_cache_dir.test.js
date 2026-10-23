'use strict';
// The directory helpers of lib/compile-cache.js: private-directory check, cache location, opt-out.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { isPrivateDir, cacheRoot, enable } = require('../lib/compile-cache');

const posix = process.platform !== 'win32';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zn-cc-dir-'));
}

test('isPrivateDir is true for a real directory with mode 0700 owned by this user', { skip: !posix }, () => {
  const base = tmp();
  try {
    const dir = path.join(base, 'private');
    fs.mkdirSync(dir);
    fs.chmodSync(dir, 0o700);
    assert.strictEqual(isPrivateDir(dir), true);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('isPrivateDir is false for a symlink to a private directory', () => {
  const base = tmp();
  try {
    const dir = path.join(base, 'private');
    fs.mkdirSync(dir, { mode: 0o700 });
    const link = path.join(base, 'link');
    try {
      fs.symlinkSync(dir, link, 'dir');
    } catch (err) {
      if (err && (err.code === 'EPERM' || err.code === 'EACCES')) return; // no symlink right here
      throw err;
    }
    assert.strictEqual(isPrivateDir(link), false);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('isPrivateDir is false when group or others can write', { skip: !posix }, () => {
  const base = tmp();
  try {
    const dir = path.join(base, 'open');
    fs.mkdirSync(dir);
    fs.chmodSync(dir, 0o777);
    assert.strictEqual(isPrivateDir(dir), false);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('cacheRoot uses ZN_HOME, resolved to an absolute path, when it is set', () => {
  const base = tmp();
  try {
    assert.strictEqual(cacheRoot({ ZN_HOME: base }), path.join(base, 'cache', 'compile'));
    const rel = path.relative(process.cwd(), base);
    const root = cacheRoot({ ZN_HOME: rel });
    assert.ok(path.isAbsolute(root));
    assert.strictEqual(root, path.join(path.resolve(rel), 'cache', 'compile'));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('cacheRoot falls back to ~/.zn/cache/compile without ZN_HOME', () => {
  const root = cacheRoot({});
  assert.strictEqual(root, path.join(os.homedir(), '.zn', 'cache', 'compile'));
  assert.ok(root.endsWith(path.join('cache', 'compile')));
});

test('enable returns null and creates nothing when ZN_NO_COMPILE_CACHE is set', () => {
  const base = tmp();
  try {
    const home = path.join(base, 'zn-home');
    assert.strictEqual(enable({ ZN_HOME: home, ZN_NO_COMPILE_CACHE: '1' }), null);
    assert.strictEqual(fs.existsSync(home), false);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
