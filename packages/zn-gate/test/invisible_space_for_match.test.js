'use strict';

// spaceInvisibleForMatch turns each invisible character into one space.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spaceInvisibleForMatch } = require('../lib/invisible');

test('zero-width characters between letters become spaces', () => {
  assert.equal(spaceInvisibleForMatch('a​b‌c‍d'), 'a b c d');
  assert.equal(spaceInvisibleForMatch('ab⁠﻿cd'), 'ab  cd');
});

test('a variation selector becomes one space', () => {
  assert.equal(spaceInvisibleForMatch('a️b'), 'a b');
});

test('an astral invisible character becomes a single space', () => {
  assert.equal(spaceInvisibleForMatch('a\u{E0041}b'), 'a b');
  assert.equal(spaceInvisibleForMatch('a\u{E0100}b'), 'a b');
});

test('ordinary spaces and visible text are kept as they are', () => {
  assert.equal(spaceInvisibleForMatch('hello  world '), 'hello  world ');
  assert.equal(spaceInvisibleForMatch('plain text'), 'plain text');
});

test('an empty string stays empty', () => {
  assert.equal(spaceInvisibleForMatch(''), '');
});
