'use strict';
// Server keys, labels, display names and the canonical form used for tool hashes
// in lib/mcp-pins.js. Fake values only; files are made in temporary folders.

process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tempDir } = require('./helpers/tmp');
const pins = require('../lib/mcp-pins');

test('canonical ignores key order at every depth', () => {
  const a = { z: 1, a: { y: [1, { q: 1, p: 2 }], x: null }, m: 'text' };
  const b = { m: 'text', a: { x: null, y: [1, { p: 2, q: 1 }] }, z: 1 };
  assert.strictEqual(pins.canonical(a), pins.canonical(b));
  assert.strictEqual(pins.canonical(a), '{"a":{"x":null,"y":[1,{"p":2,"q":1}]},"m":"text","z":1}');
});

test('canonical keeps the order of array items', () => {
  assert.notStrictEqual(pins.canonical({ a: [1, 2] }), pins.canonical({ a: [2, 1] }));
  assert.strictEqual(pins.canonical([{ b: 1, a: 2 }, [3, 1]]), '[{"a":2,"b":1},[3,1]]');
});

test('canonical tells apart values of different types and nesting levels', () => {
  assert.notStrictEqual(pins.canonical({ a: 1 }), pins.canonical({ a: '1' }));
  assert.notStrictEqual(pins.canonical({ a: {} }), pins.canonical({ a: [] }));
  assert.notStrictEqual(pins.canonical({ a: { b: 1 } }), pins.canonical({ a: 1, b: 1 }));
  assert.strictEqual(pins.canonical({ a: undefined, b: [undefined] }), '{"a":null,"b":[null]}');
});

test('canonical handles unicode and quoting in keys and values', () => {
  const value = { 'zéta': 'ü', 'alpha': '日本語', 'q"uote': 'a\nb' };
  assert.strictEqual(pins.canonical(value), '{"alpha":"日本語","q\\"uote":"a\\nb","zéta":"ü"}');
});

test('serverKey is 16 hex characters and stable', () => {
  const key = pins.serverKey('node-fake-program', ['--flag', 'value']);
  assert.match(key, /^[0-9a-f]{16}$/);
  assert.strictEqual(key, pins.serverKey('node-fake-program', ['--flag', 'value']));
});

test('serverKey depends on the program, on each argument and on their order', () => {
  const base = pins.serverKey('prog-a', ['one', 'two']);
  assert.notStrictEqual(base, pins.serverKey('prog-b', ['one', 'two']));
  assert.notStrictEqual(base, pins.serverKey('prog-a', ['two', 'one']));
  assert.notStrictEqual(base, pins.serverKey('prog-a', ['one']));
  assert.notStrictEqual(base, pins.serverKey('prog-a', ['one two']));
  assert.strictEqual(pins.serverKey('prog-a', []), pins.serverKey('prog-a'));
  assert.strictEqual(pins.serverKey('prog-a', ['1']), pins.serverKey('prog-a', [1]));
});

test('serverKey tells apart unicode names, also the same text composed differently', () => {
  const a = pins.serverKey('prog-a', ['--name', 'wetter-\u00e9']);
  const b = pins.serverKey('prog-a', ['--name', 'wetter-é']);
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.notStrictEqual(a, b);
  assert.notStrictEqual(a, pins.serverKey('prog-a', ['--name', '天気']));
});

test('serverKey resolves a script given by a relative path, so two folders are two servers', (t) => {
  const one = tempDir(t, 'pins-key-one-');
  const two = tempDir(t, 'pins-key-two-');
  const cwd = process.cwd();
  try {
    fs.writeFileSync(path.join(one, 'server.js'), '');
    fs.writeFileSync(path.join(two, 'server.js'), '');
    process.chdir(one);
    const keyOne = pins.serverKey('node', ['server.js']);
    process.chdir(two);
    const keyTwo = pins.serverKey('node', ['server.js']);
    assert.notStrictEqual(keyOne, keyTwo);
    assert.strictEqual(keyTwo, pins.serverKey('node', [path.join(two, 'server.js')]));
    // A name that is not a file here stays as written.
    assert.strictEqual(pins.serverKey('node', ['missing.js']), pins.serverKey('node', ['missing.js']));
    assert.notStrictEqual(pins.serverKey('node', ['missing.js']), keyTwo);
  } finally {
    process.chdir(cwd);
  }
});

test('two servers can share one label and still have different keys', (t) => {
  const one = tempDir(t, 'pins-same-one-');
  const two = tempDir(t, 'pins-same-two-');
  const a = path.join(one, 'server.js');
  const b = path.join(two, 'server.js');
  fs.writeFileSync(a, '');
  fs.writeFileSync(b, '');
  assert.notStrictEqual(pins.serverKey('node', [a]), pins.serverKey('node', [b]));
  // The program name is shown without its folder, so two different programs can look alike.
  assert.strictEqual(pins.label('/opt/one/fake-server', ['--x']), 'fake-server --x');
  assert.strictEqual(pins.label('/opt/two/fake-server', ['--x']), 'fake-server --x');
  assert.notStrictEqual(pins.serverKey('/opt/one/fake-server', ['--x']), pins.serverKey('/opt/two/fake-server', ['--x']));
});

test('label shows the program name and its arguments', () => {
  assert.strictEqual(pins.label('node', ['--flag', 'value']), 'node --flag value');
  assert.strictEqual(pins.label('/usr/local/bin/fake-tool', []), 'fake-tool');
  assert.strictEqual(pins.label('fake-tool'), 'fake-tool');
});

test('label keeps unicode and replaces control characters', () => {
  assert.strictEqual(pins.label('node', ['--name', '天気-é']), 'node --name 天気-é');
  assert.strictEqual(pins.label('node', ['a\u001b[2Kb']), 'node a?[2Kb');
});

test('label is at most 200 characters', () => {
  assert.ok(pins.label('node', ['x'.repeat(500)]).length <= 200);
});

test('displayName keeps short and unicode names as they are', () => {
  assert.strictEqual(pins.displayName('weather'), 'weather');
  assert.strictEqual(pins.displayName('wetter-é 天気'), 'wetter-é 天気');
  assert.strictEqual(pins.displayName(42), '42');
});

test('displayName replaces control and format characters', () => {
  assert.strictEqual(pins.displayName('a\u0000b\tc​d‮e'), 'a?b?c?d?e');
});

test('displayName cuts a long name at 80 characters and marks the cut', () => {
  assert.strictEqual(pins.displayName('n'.repeat(80)), 'n'.repeat(80));
  assert.strictEqual(pins.displayName('n'.repeat(81)), 'n'.repeat(80) + '...');
});
