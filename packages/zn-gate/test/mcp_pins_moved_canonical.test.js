'use strict';
// pinsMoved and canonical from lib/mcp-pins.js.

process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const pins = require('../lib/mcp-pins');

function withEnv(env, fn) {
  const names = ['HOME', 'USERPROFILE', 'ZN_HOME'];
  const saved = {};
  for (const k of names) saved[k] = process.env[k];
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  try {
    return fn();
  } finally {
    for (const k of names) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
}

function accountDotZn() {
  let h;
  try { h = os.userInfo().homedir; } catch (_) { /* no passwd entry */ }
  return path.join(h || os.homedir(), '.zn');
}

test('pinsMoved is true when ZN_HOME names another folder', (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zn-moved-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.strictEqual(withEnv({ ZN_HOME: dir }, () => pins.pinsMoved()), true);
});

test('pinsMoved is false when ZN_HOME is the account .zn folder, even written differently', () => {
  const own = accountDotZn();
  assert.strictEqual(withEnv({ ZN_HOME: own }, () => pins.pinsMoved()), false);
  assert.strictEqual(withEnv({ ZN_HOME: path.join(own, '..', path.basename(own)) }, () => pins.pinsMoved()), false);
});

test('pinsMoved is true when HOME points elsewhere and ZN_HOME is not set', (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zn-moved-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.strictEqual(withEnv({ HOME: dir, USERPROFILE: dir, ZN_HOME: undefined }, () => pins.pinsMoved()), true);
});

test('canonical sorts object keys at every depth', () => {
  assert.strictEqual(pins.canonical({ b: 1, a: { d: 2, c: 3 } }), '{"a":{"c":3,"d":2},"b":1}');
  assert.strictEqual(pins.canonical({ a: 1, b: 2 }), pins.canonical({ b: 2, a: 1 }));
});

test('canonical keeps array order and nests objects in arrays', () => {
  assert.strictEqual(pins.canonical([2, 1, { y: 1, x: 0 }]), '[2,1,{"x":0,"y":1}]');
  assert.notStrictEqual(pins.canonical([1, 2]), pins.canonical([2, 1]));
});

test('canonical writes scalars as JSON and undefined as null', () => {
  assert.strictEqual(pins.canonical('a"b'), '"a\\"b"');
  assert.strictEqual(pins.canonical(5), '5');
  assert.strictEqual(pins.canonical(true), 'true');
  assert.strictEqual(pins.canonical(null), 'null');
  assert.strictEqual(pins.canonical(undefined), 'null');
  assert.strictEqual(pins.canonical({ a: undefined }), '{"a":null}');
  assert.strictEqual(pins.canonical([undefined]), '[null]');
  assert.strictEqual(pins.canonical({}), '{}');
  assert.strictEqual(pins.canonical([]), '[]');
});
