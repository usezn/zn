'use strict';

// The text the rules match must be the same in Node.js and Python when a line break sits next to U+0085.
// Python's \s counts U+0085 and U+001C-U+001F as whitespace, JavaScript's does not: the run is listed explicitly.

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeInput } = require('../lib/rules');

test('normalizeInput: a word split by U+0085 and a line break is rejoined', () => {
  assert.equal(normalizeInput('sys\u0085\ntem').stripped, 'system');
  assert.equal(normalizeInput('sys\n\u0085tem').stripped, 'system');
  assert.equal(normalizeInput('sys\u001c\n\u001ftem').stripped, 'system');
});

test('normalizeInput: U+0085 alone does not rejoin and spaces next to it stay', () => {
  assert.equal(normalizeInput('sys\u0085tem').stripped, 'sys\u0085tem');
  assert.equal(normalizeInput('go \u0085 now').stripped, 'go \u0085 now');
});
