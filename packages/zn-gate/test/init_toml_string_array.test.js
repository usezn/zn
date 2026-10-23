'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseTomlStringArray } = require('../lib/init')._internal;

test('parseTomlStringArray - double and single quoted elements keep order', () => {
  assert.deepEqual(parseTomlStringArray(`["a", 'b']`), ['a', 'b']);
});

test('parseTomlStringArray - empty array gives an empty list', () => {
  assert.deepEqual(parseTomlStringArray('[]'), []);
});

test('parseTomlStringArray - spaces and a trailing comma are accepted', () => {
  assert.deepEqual(parseTomlStringArray('  [  "a" ,  "b" , ]  '), ['a', 'b']);
});

test('parseTomlStringArray - a trailing comment is accepted', () => {
  assert.deepEqual(parseTomlStringArray('["a"] # note'), ['a']);
});

test('parseTomlStringArray - text after the bracket that is not a comment gives null', () => {
  assert.equal(parseTomlStringArray('["a"] extra'), null);
});

test('parseTomlStringArray - input without an opening bracket gives null', () => {
  assert.equal(parseTomlStringArray('"a"]'), null);
});

test('parseTomlStringArray - unterminated array gives null', () => {
  assert.equal(parseTomlStringArray('["a", "b"'), null);
});

test('parseTomlStringArray - unquoted element gives null', () => {
  assert.equal(parseTomlStringArray('[a, "b"]'), null);
});

test('parseTomlStringArray - multi-line string element gives null', () => {
  assert.equal(parseTomlStringArray('["""a\nb"""]'), null);
});

test('parseTomlStringArray - JSON-style escapes in double quotes are decoded', () => {
  assert.deepEqual(parseTomlStringArray('["a\\tb", "q\\"x", "\\u0041"]'), ['a\tb', 'q"x', 'A']);
});
