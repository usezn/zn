'use strict';
// normName cleans agent names before they are used as counter keys.

const test = require('node:test');
const assert = require('node:assert/strict');
const { normName } = require('../lib/stats');

test('normName lowercases the input', () => {
  assert.equal(normName('Claude-Code'), 'claude-code');
});

test('normName turns a run of other characters into one hyphen', () => {
  assert.equal(normName('my agent'), 'my-agent');
  assert.equal(normName('a   b!!c'), 'a-b-c');
  assert.equal(normName('a_b.c/d'), 'a-b-c-d');
});

test('normName removes leading hyphens but keeps trailing ones', () => {
  assert.equal(normName('--abc'), 'abc');
  assert.equal(normName('  abc'), 'abc');
  assert.equal(normName('abc--'), 'abc--');
  assert.equal(normName('abc!'), 'abc-');
});

test('normName cuts the result at 32 characters', () => {
  assert.equal(normName('a'.repeat(40)), 'a'.repeat(32));
  assert.equal(normName('a'.repeat(32)), 'a'.repeat(32));
});

test('normName returns other for empty or missing input', () => {
  assert.equal(normName(''), 'other');
  assert.equal(normName(undefined), 'other');
  assert.equal(normName(null), 'other');
});

test('normName returns other when nothing valid is left', () => {
  assert.equal(normName('---'), 'other');
  assert.equal(normName('!!!'), 'other');
  assert.equal(normName('   '), 'other');
});
