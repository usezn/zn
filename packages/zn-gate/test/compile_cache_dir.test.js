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

// ---- a temporary HOME (no ZN_HOME): new, existing, foreign and unwritable folders ----

const { spawnSync } = require('child_process');

const isRoot = posix && typeof process.getuid === 'function' && process.getuid() === 0;

// Run enable() in a child with HOME set, so the process-wide compile cache of the runner is not involved.
function enableWithHome(home) {
  const code = 'const r = require(' + JSON.stringify(require.resolve('../lib/compile-cache')) +
    ').enable(); console.log(JSON.stringify(r));';
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.ZN_HOME;
  delete env.ZN_NO_COMPILE_CACHE;
  delete env.NODE_COMPILE_CACHE;
  const res = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', env });
  assert.strictEqual(res.status, 0, res.stderr);
  return JSON.parse(res.stdout.trim());
}

const hasCompileCache = typeof require('module').enableCompileCache === 'function';

test('cacheRoot follows a temporary HOME when ZN_HOME is not set', { skip: !posix }, () => {
  const base = tmp();
  try {
    const code = 'console.log(require(' + JSON.stringify(require.resolve('../lib/compile-cache')) +
      ').cacheRoot({}))';
    const env = { ...process.env, HOME: base };
    const res = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', env });
    assert.strictEqual(res.status, 0, res.stderr);
    assert.strictEqual(res.stdout.trim(), path.join(base, '.zn', 'cache', 'compile'));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('enable in a new HOME creates private folders under ~/.zn', { skip: !posix || !hasCompileCache }, () => {
  const base = tmp();
  try {
    const dir = enableWithHome(base);
    assert.ok(dir, 'a cache directory is returned');
    assert.strictEqual(fs.realpathSync(dir), fs.realpathSync(path.join(base, '.zn', 'cache', 'compile')));
    for (const d of [path.join(base, '.zn'), path.join(base, '.zn', 'cache'), path.join(base, '.zn', 'cache', 'compile')]) {
      assert.strictEqual(fs.statSync(d).mode & 0o077, 0, d + ' must be private');
      assert.strictEqual(isPrivateDir(d), true);
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('enable reuses an existing private ~/.zn and keeps its files', { skip: !posix || !hasCompileCache }, () => {
  const base = tmp();
  try {
    const zn = path.join(base, '.zn');
    fs.mkdirSync(zn, { mode: 0o700 });
    fs.writeFileSync(path.join(zn, 'keep.txt'), 'x');
    const dir = enableWithHome(base);
    assert.ok(dir);
    assert.strictEqual(fs.readFileSync(path.join(zn, 'keep.txt'), 'utf8'), 'x');
    // A second call finds the folders it made and still succeeds.
    assert.strictEqual(enableWithHome(base), dir);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('enable is skipped when ~/.zn is open to other users', { skip: !posix }, () => {
  const base = tmp();
  try {
    const zn = path.join(base, '.zn');
    fs.mkdirSync(zn);
    fs.chmodSync(zn, 0o775);
    assert.strictEqual(enableWithHome(base), null);
    assert.strictEqual(fs.existsSync(path.join(zn, 'cache')), false);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('a folder owned by another user is not private (needs root to set up)', { skip: !isRoot }, () => {
  const base = tmp();
  try {
    const zn = path.join(base, '.zn');
    fs.mkdirSync(zn, { mode: 0o700 });
    fs.chownSync(zn, 65534, 65534);
    assert.strictEqual(isPrivateDir(zn), false);
    assert.strictEqual(enable({ ZN_HOME: zn }), null);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('enable is skipped when HOME cannot be written to', { skip: !posix || isRoot }, () => {
  const base = tmp();
  try {
    fs.chmodSync(base, 0o500);
    assert.strictEqual(enableWithHome(base), null);
    assert.strictEqual(fs.existsSync(path.join(base, '.zn')), false);
  } finally {
    fs.chmodSync(base, 0o700);
    fs.rmSync(base, { recursive: true, force: true });
  }
});
