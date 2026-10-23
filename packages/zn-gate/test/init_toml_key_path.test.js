'use strict';
// parseTomlKeyPath splits a dotted TOML key such as mcp_servers."my server"
// into its parts. Anything it cannot read cleanly gives an empty list.

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseTomlKeyPath } = require('../lib/init')._internal;

test('a bare dotted key gives two parts', () => {
  assert.deepEqual(parseTomlKeyPath('mcp_servers.demo'), ['mcp_servers', 'demo']);
});

test('a single bare key gives one part', () => {
  assert.deepEqual(parseTomlKeyPath('demo-1_x'), ['demo-1_x']);
});

test('a double-quoted part with spaces stays one part', () => {
  assert.deepEqual(parseTomlKeyPath('mcp_servers."my server"'), ['mcp_servers', 'my server']);
});

test('a double-quoted part with a dot stays one part', () => {
  assert.deepEqual(parseTomlKeyPath('mcp_servers."a.b"'), ['mcp_servers', 'a.b']);
});

test('a single-quoted part is taken literally', () => {
  assert.deepEqual(parseTomlKeyPath("mcp_servers.'a\\nb.c'"), ['mcp_servers', 'a\\nb.c']);
});

test('escapes inside a double-quoted part are decoded', () => {
  assert.deepEqual(parseTomlKeyPath('a."x\\ty\\u0041\\"z"'), ['a', 'x\tyA"z']);
});

test('whitespace around parts is ignored', () => {
  assert.deepEqual(parseTomlKeyPath('  mcp_servers .  demo  '), ['mcp_servers', 'demo']);
});

test('an empty string gives an empty list', () => {
  assert.deepEqual(parseTomlKeyPath(''), []);
});

test('a trailing dot is accepted and adds no part', () => {
  assert.deepEqual(parseTomlKeyPath('mcp_servers.'), ['mcp_servers']);
});

test('an empty part between dots gives an empty list', () => {
  assert.deepEqual(parseTomlKeyPath('mcp_servers..demo'), []);
  assert.deepEqual(parseTomlKeyPath('.'), []);
});

test('an unterminated quote gives an empty list', () => {
  assert.deepEqual(parseTomlKeyPath('mcp_servers."demo'), []);
  assert.deepEqual(parseTomlKeyPath("mcp_servers.'demo"), []);
});

test('a bare part with other characters gives an empty list', () => {
  assert.deepEqual(parseTomlKeyPath('mcp_servers.de mo'), []);
  assert.deepEqual(parseTomlKeyPath('mcp_servers.demo!'), []);
});
