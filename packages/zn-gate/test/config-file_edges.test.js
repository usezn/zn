'use strict';
/*
 * Edge cases of quoteArg in lib/agents/config-file.js: empty and odd input,
 * quotes and backslashes, the platform argument, and the NUL error path.
 * Only fake values; nothing is read from or written to disk.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { quoteArg } = require('../lib/agents/config-file');

test('quoteArg: an empty string is an empty single-quoted word', () => {
  assert.equal(quoteArg('', 'linux'), "''");
  assert.equal(quoteArg('', 'win32'), "''");
});

test('quoteArg: non-string input is converted to text', () => {
  assert.equal(quoteArg(42, 'linux'), "'42'");
  assert.equal(quoteArg(null, 'linux'), "'null'");
  assert.equal(quoteArg(undefined, 'linux'), "'undefined'");
});

test('quoteArg: a plain path is only wrapped in single quotes', () => {
  assert.equal(quoteArg('/usr/bin/node', 'linux'), "'/usr/bin/node'");
  assert.equal(quoteArg('/my dir/a b', 'linux'), "'/my dir/a b'");
});

test('quoteArg: a single quote is written as a double-quoted quote between two words', () => {
  assert.equal(quoteArg("/a'b", 'linux'), "'/a'\"'\"'b'");
  assert.equal(quoteArg("'", 'linux'), "''\"'\"''");
});

test('quoteArg: typographic single quotes are moved out of the quotes too', () => {
  assert.equal(quoteArg('/a\u2019b', 'linux'), "'/a'\"\u2019\"'b'");
});

test('quoteArg: a backslash is kept on linux but becomes / on win32', () => {
  assert.equal(quoteArg('a\\b', 'linux'), "'a'\"\\\\\"'b'");
  assert.equal(quoteArg('a\\b', 'win32'), "'a/b'");
  assert.equal(quoteArg('C:\\x\\', 'win32'), "'C:/x/'");
});

test('quoteArg: shell characters and newlines stay inside the quotes', () => {
  assert.equal(quoteArg('$HOME;`x`\n"y"', 'linux'), "'$HOME;`x`\n\"y\"'");
});

test('quoteArg: an unknown platform name behaves like linux', () => {
  assert.equal(quoteArg('a\\b', 'plan9'), quoteArg('a\\b', 'linux'));
});

test('quoteArg: a NUL character is refused', () => {
  assert.throws(() => quoteArg('/a\0b', 'linux'));
  assert.throws(() => quoteArg('\0', 'win32'));
});
