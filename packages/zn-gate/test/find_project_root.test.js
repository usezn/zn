'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { findProjectRoot } = require('../lib/deps');

function makeTree(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-root-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return fs.realpathSync(base);
}

test('findProjectRoot returns the nearest parent with a .git directory', (t) => {
  const base = makeTree(t);
  fs.mkdirSync(path.join(base, '.git'));
  const deep = path.join(base, 'a', 'b');
  fs.mkdirSync(deep, { recursive: true });
  assert.strictEqual(findProjectRoot(deep), base);
});

test('findProjectRoot prefers the nearest .git over an outer one', (t) => {
  const base = makeTree(t);
  fs.mkdirSync(path.join(base, '.git'));
  const inner = path.join(base, 'inner');
  fs.mkdirSync(path.join(inner, '.git'), { recursive: true });
  const deep = path.join(inner, 'src');
  fs.mkdirSync(deep);
  assert.strictEqual(findProjectRoot(deep), inner);
});

test('findProjectRoot accepts a .git file, as in a worktree', (t) => {
  const base = makeTree(t);
  fs.writeFileSync(path.join(base, '.git'), 'gitdir: /example/elsewhere\n');
  const deep = path.join(base, 'pkg');
  fs.mkdirSync(deep);
  assert.strictEqual(findProjectRoot(deep), base);
});

test('findProjectRoot returns the resolved start dir when no parent has .git', (t) => {
  const base = makeTree(t);
  const deep = path.join(base, 'x', 'y');
  fs.mkdirSync(deep, { recursive: true });
  assert.strictEqual(findProjectRoot(deep), deep);
});

test('findProjectRoot uses the current directory when called without an argument', (t) => {
  const base = makeTree(t);
  fs.mkdirSync(path.join(base, '.git'));
  const deep = path.join(base, 'sub');
  fs.mkdirSync(deep);
  const prev = process.cwd();
  process.chdir(deep);
  try {
    assert.strictEqual(fs.realpathSync(findProjectRoot()), base);
  } finally {
    // Leave the temp dir before it is removed (required on Windows).
    process.chdir(prev);
  }
});
