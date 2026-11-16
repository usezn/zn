'use strict';
// pinsDir and pinsMoved with a temporary HOME: the pins folder at the default
// place (HOME/.zn), at a place named by ZN_HOME, at both, at neither, and a
// plain file where the folder should be. Both functions only work out paths.

process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const pins = require('../lib/mcp-pins');

const KEYS = ['HOME', 'USERPROFILE', 'ZN_HOME'];

function tmp(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zn-pins-loc-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function withEnv(env, fn) {
  const saved = {};
  for (const k of KEYS) saved[k] = process.env[k];
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, env);
  try {
    return fn();
  } finally {
    for (const k of KEYS) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
}

const homeEnv = (home, extra) => Object.assign({ HOME: home, USERPROFILE: home }, extra);

test('folder only at the default place under HOME: pinsDir points there', (t) => {
  const home = tmp(t);
  fs.mkdirSync(path.join(home, '.zn', 'mcp-pins'), { recursive: true });
  withEnv(homeEnv(home), () => {
    assert.strictEqual(pins.pinsDir(), path.join(home, '.zn', 'mcp-pins'));
    assert.strictEqual(typeof pins.pinsMoved(), 'boolean');
  });
});

test('folder only at the new place named by ZN_HOME: pinsDir follows it and pins are moved', (t) => {
  const home = tmp(t);
  const elsewhere = path.join(tmp(t), 'zn-state');
  fs.mkdirSync(path.join(elsewhere, 'mcp-pins'), { recursive: true });
  withEnv(homeEnv(home, { ZN_HOME: elsewhere }), () => {
    assert.strictEqual(pins.pinsDir(), path.join(elsewhere, 'mcp-pins'));
    assert.strictEqual(pins.pinsMoved(), true);
  });
});

test('folders at both places: ZN_HOME wins', (t) => {
  const home = tmp(t);
  const elsewhere = path.join(tmp(t), 'zn-state');
  fs.mkdirSync(path.join(home, '.zn', 'mcp-pins'), { recursive: true });
  fs.mkdirSync(path.join(elsewhere, 'mcp-pins'), { recursive: true });
  withEnv(homeEnv(home, { ZN_HOME: elsewhere }), () => {
    assert.strictEqual(pins.pinsDir(), path.join(elsewhere, 'mcp-pins'));
    assert.strictEqual(pins.pinsMoved(), true);
  });
});

test('no folder at either place: both functions still answer and create nothing', (t) => {
  const home = tmp(t);
  withEnv(homeEnv(home), () => {
    assert.strictEqual(pins.pinsDir(), path.join(home, '.zn', 'mcp-pins'));
    pins.pinsMoved();
    assert.deepStrictEqual(fs.readdirSync(home), []);
    assert.deepStrictEqual(pins.list(), []);
  });
});

test('a relative ZN_HOME is resolved to an absolute path', (t) => {
  const home = tmp(t);
  withEnv(homeEnv(home, { ZN_HOME: 'relative-zn' }), () => {
    assert.strictEqual(pins.pinsDir(), path.join(path.resolve('relative-zn'), 'mcp-pins'));
    assert.strictEqual(pins.pinsMoved(), true);
  });
});

test('a plain file where the folder should be: path is unchanged and list is empty', (t) => {
  const home = tmp(t);
  fs.mkdirSync(path.join(home, '.zn'), { recursive: true });
  fs.writeFileSync(path.join(home, '.zn', 'mcp-pins'), 'not a folder');
  withEnv(homeEnv(home), () => {
    assert.strictEqual(pins.pinsDir(), path.join(home, '.zn', 'mcp-pins'));
    assert.deepStrictEqual(pins.list(), []);
    assert.strictEqual(fs.readFileSync(path.join(home, '.zn', 'mcp-pins'), 'utf8'), 'not a folder');
  });
});

test('a plain file in place of ZN_HOME itself: pinsDir is below it and list is empty', (t) => {
  const home = tmp(t);
  const file = path.join(tmp(t), 'zn-file');
  fs.writeFileSync(file, 'x');
  withEnv(homeEnv(home, { ZN_HOME: file }), () => {
    assert.strictEqual(pins.pinsDir(), path.join(file, 'mcp-pins'));
    assert.strictEqual(pins.pinsMoved(), true);
    assert.deepStrictEqual(pins.list(), []);
  });
});
