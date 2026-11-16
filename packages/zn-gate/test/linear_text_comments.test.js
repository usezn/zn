'use strict';

// Comment and trailing-character cases for the linear-time text helpers,
// describing the behaviour as it is today.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { stripInlineComment, trimTrailing } = require('../lib/linear-text');

test('stripInlineComment: comment after a blank, hash inside a word', () => {
  assert.equal(stripInlineComment('token # note'), 'token');
  assert.equal(stripInlineComment('a#b c#d'), 'a#b c#d');
  assert.equal(stripInlineComment('a#b # c'), 'a#b');
});

test('stripInlineComment: no comment, or only a comment', () => {
  assert.equal(stripInlineComment('plain value'), 'plain value');
  assert.equal(stripInlineComment('# only'), '# only');
  assert.equal(stripInlineComment('  # only'), '');
  assert.equal(stripInlineComment(' #'), '');
});

test('stripInlineComment: only the last line is looked at, with LF', () => {
  assert.equal(stripInlineComment('a\nb # c'), 'a\nb');
  assert.equal(stripInlineComment('a # c\nb'), 'a # c\nb');
  assert.equal(stripInlineComment('a # c\nb\nd # e'), 'a # c\nb\nd');
  assert.equal(stripInlineComment('a\n# c'), 'a');
});

test('stripInlineComment: only the last line is looked at, with CRLF', () => {
  assert.equal(stripInlineComment('a\r\nb # c'), 'a\r\nb');
  assert.equal(stripInlineComment('a # c\r\nb'), 'a # c\r\nb');
  assert.equal(stripInlineComment('a # c\r\nb\r\nd # e'), 'a # c\r\nb\r\nd');
  assert.equal(stripInlineComment('a\r\n# c'), 'a');
});

test('trimTrailing: no chars, absent chars, only those chars', () => {
  assert.equal(trimTrailing('abc//', ''), 'abc//');
  assert.equal(trimTrailing('abc//', '=*'), 'abc//');
  assert.equal(trimTrailing('abc', '/'), 'abc');
  assert.equal(trimTrailing('/=/=', '/='), '');
  assert.equal(trimTrailing('====', '='), '');
});
