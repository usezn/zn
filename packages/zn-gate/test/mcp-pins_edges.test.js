'use strict';
// Edge cases of displayName, label and pinsDir in lib/mcp-pins.js.

process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const { tempDir } = require('./helpers/tmp');
const pins = require('../lib/mcp-pins');

function withEnv(env, fn) {
  const saved = {};
  for (const k of Object.keys(env)) saved[k] = process.env[k];
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}

test('displayName: empty and non-string input', () => {
  assert.strictEqual(pins.displayName(''), '');
  assert.strictEqual(pins.displayName(undefined), 'undefined');
  assert.strictEqual(pins.displayName(null), 'null');
  assert.strictEqual(pins.displayName(42), '42');
});

test('displayName: length boundary at 80 characters', () => {
  assert.strictEqual(pins.displayName('a'.repeat(80)), 'a'.repeat(80));
  assert.strictEqual(pins.displayName('a'.repeat(81)), 'a'.repeat(80) + '...');
});

test('displayName: replaces control and format characters, keeps plain text', () => {
  assert.strictEqual(pins.displayName('a\tb\nc'), 'a?b?c');
  assert.strictEqual(pins.displayName('a​b'), 'a?b');
  assert.strictEqual(pins.displayName('café server'), 'café server');
});

test('label: uses the program base name and joins arguments', () => {
  assert.strictEqual(pins.label('/usr/bin/node', ['--flag', 'value']), 'node --flag value');
  assert.strictEqual(pins.label('node'), 'node');
  assert.strictEqual(pins.label('node', []), 'node');
});

test('label: is cut by displayName to 80 characters plus an ellipsis', () => {
  assert.strictEqual(pins.label('node', Array(100).fill('word')).length, 83);
});

test('label: control characters in arguments are replaced', () => {
  assert.strictEqual(pins.label('node', ['a\nb']), 'node a?b');
});

test('label: accepts non-string arguments', () => {
  assert.strictEqual(pins.label('node', [1, 2]), 'node 1 2');
});

test('pinsDir: ZN_HOME wins and is resolved', (t) => {
  const dir = tempDir(t, 'zn-pins-edges-');
  withEnv({ ZN_HOME: dir }, () => {
    assert.strictEqual(pins.pinsDir(), path.join(dir, 'mcp-pins'));
  });
  withEnv({ ZN_HOME: path.join(dir, 'a', '..', 'b') }, () => {
    assert.strictEqual(pins.pinsDir(), path.join(dir, 'b', 'mcp-pins'));
  });
});

test('pinsDir: an empty ZN_HOME falls back to the home folder', () => {
  withEnv({ ZN_HOME: '' }, () => {
    assert.strictEqual(pins.pinsDir(), path.join(os.homedir(), '.zn', 'mcp-pins'));
  });
});
