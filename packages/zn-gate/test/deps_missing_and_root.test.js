'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { loadEngine, findProjectRoot } = require('../lib/deps');

function makeTmp(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-deps-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return fs.realpathSync(base);
}

// Make require('./scrub/engine') from lib/deps.js throw `err`.
function failEngine(t, err) {
  const original = Module._load;
  Module._load = function (req, parent, ...rest) {
    if (req === './scrub/engine' && parent && /deps\.js$/.test(parent.filename || '')) throw err;
    return original.call(this, req, parent, ...rest);
  };
  t.after(() => { Module._load = original; });
}

// isMissing is private, so it is checked through loadEngine.
test('a MODULE_NOT_FOUND error naming the engine path becomes ZN_UNAVAILABLE', (t) => {
  const err = new Error("Cannot find module './scrub/engine'");
  err.code = 'MODULE_NOT_FOUND';
  failEngine(t, err);
  assert.throws(() => loadEngine(), (e) => e.code === 'ZN_UNAVAILABLE');
});

test('an error of another kind that names the engine path is rethrown as is', (t) => {
  const err = new Error("Cannot find module './scrub/engine'");
  err.code = 'ERR_FAKE_OTHER';
  failEngine(t, err);
  assert.throws(() => loadEngine(), (e) => e === err);
});

test('a MODULE_NOT_FOUND error without a message path is rethrown as is', (t) => {
  const err = new Error('something else is gone');
  err.code = 'MODULE_NOT_FOUND';
  failEngine(t, err);
  assert.throws(() => loadEngine(), (e) => e === err);
});

test('a thrown value that is not an error object is rethrown as is', (t) => {
  failEngine(t, null);
  assert.throws(() => loadEngine(), (e) => e === null);
});

test('findProjectRoot ignores a package.json and finds the .git above it', (t) => {
  const base = makeTmp(t);
  fs.mkdirSync(path.join(base, '.git'));
  const pkg = path.join(base, 'packages', 'app');
  const nested = path.join(pkg, 'src', 'deep');
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), '{"name":"fake-app"}\n');
  assert.strictEqual(findProjectRoot(nested), base);
});

test('findProjectRoot returns the start dir when only a package.json exists', (t) => {
  const base = makeTmp(t);
  const nested = path.join(base, 'app', 'src');
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(base, 'app', 'package.json'), '{"name":"fake-app"}\n');
  assert.strictEqual(findProjectRoot(nested), nested);
});

test('findProjectRoot gives the same answer for a folder with and without package.json', (t) => {
  const base = makeTmp(t);
  fs.mkdirSync(path.join(base, '.git'));
  const withPkg = path.join(base, 'with');
  const without = path.join(base, 'without');
  fs.mkdirSync(withPkg);
  fs.mkdirSync(without);
  fs.writeFileSync(path.join(withPkg, 'package.json'), '{}\n');
  assert.strictEqual(findProjectRoot(withPkg), base);
  assert.strictEqual(findProjectRoot(without), base);
});
