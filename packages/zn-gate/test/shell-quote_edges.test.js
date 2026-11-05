'use strict';

process.env.ZN_STATS = 'off';

// Edge cases of portablePath() and the quoting helpers around it.

const test = require('node:test');
const assert = require('node:assert/strict');
const sq = require('../lib/shell-quote');

test('portablePath: empty string stays empty on every platform', () => {
  assert.equal(sq.portablePath('', 'win32'), '');
  assert.equal(sq.portablePath('', 'linux'), '');
});

test('portablePath: non-string input is converted to text', () => {
  assert.equal(sq.portablePath(undefined, 'linux'), 'undefined');
  assert.equal(sq.portablePath(null, 'win32'), 'null');
  assert.equal(sq.portablePath(42, 'win32'), '42');
  assert.equal(sq.portablePath({ toString: () => 'a\\b' }, 'win32'), 'a/b');
});

test('portablePath: every backslash is replaced, including runs and UNC prefixes', () => {
  assert.equal(sq.portablePath('\\\\server\\share\\dir', 'win32'), '//server/share/dir');
  assert.equal(sq.portablePath('a\\\\b\\', 'win32'), 'a//b/');
  assert.equal(sq.portablePath('\\', 'win32'), '/');
});

test('portablePath: forward slashes and paths without backslashes are unchanged', () => {
  assert.equal(sq.portablePath('C:/Users/example/bin', 'win32'), 'C:/Users/example/bin');
  assert.equal(sq.portablePath('relative/path', 'win32'), 'relative/path');
});

test('portablePath: other platform names keep backslashes', () => {
  for (const p of ['darwin', 'linux', 'freebsd', 'WIN32', 'windows', '']) {
    assert.equal(sq.portablePath('a\\b', p), 'a\\b', p);
  }
});

test('portablePath: keeps spaces, quotes and non-ASCII characters', () => {
  assert.equal(sq.portablePath("C:\\My 'dir'\\é\\x", 'win32'), "C:/My 'dir'/é/x");
});

test('portablePath: uses the current platform when none is given', () => {
  const expected = process.platform === 'win32' ? 'a/b' : 'a\\b';
  assert.equal(sq.portablePath('a\\b'), expected);
});

test('portablePath: a NUL character is passed through (the quoting functions reject it)', () => {
  assert.equal(sq.portablePath('a\0b\\c', 'win32'), 'a\0b/c');
});

test('shQuote and powershellQuote: empty input and NUL', () => {
  assert.equal(sq.shQuote(''), "''");
  assert.equal(sq.powershellQuote(''), "''");
  assert.throws(() => sq.shQuote('a\0b'), /NUL/);
  assert.throws(() => sq.powershellQuote('a\0b'), /NUL/);
});

test('powershellQuote: doubles every kind of single quote', () => {
  assert.equal(sq.powershellQuote("a'b"), "'a''b'");
  assert.equal(sq.powershellQuote('\u2018\u2019'), "'\u2018\u2018\u2019\u2019'");
});

test('shQuote: moves quotes and backslashes out of the single quotes', () => {
  assert.equal(sq.shQuote("a'b"), "'a'\"'\"'b'");
  assert.equal(sq.shQuote('a\\b'), "'a'\"\\\\\"'b'");
});

test('windowsCommand: backslashes in arguments become slashes and round-trip', () => {
  const cmd = sq.windowsCommand('C:\\tools\\node.exe', ['C:\\work\\a b\\x.js']);
  assert.equal(sq.windowsCommandScript(cmd), "& 'C:/tools/node.exe' 'C:/work/a b/x.js'");
});
