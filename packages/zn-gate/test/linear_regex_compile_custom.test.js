'use strict';

// compileCustomPattern: the result for each kind of input. The size of a pattern is
// seen through the budget it takes off (budget.left).

const test = require('node:test');
const assert = require('node:assert/strict');
const { compileCustomPattern, MAX_PATTERN_LENGTH, MAX_TOTAL_PROGRAM } = require('../lib/linear-regex');

function sizeOf(src) {
  const budget = { left: MAX_TOTAL_PROGRAM };
  const r = compileCustomPattern(src, budget);
  return { r, size: MAX_TOTAL_PROGRAM - budget.left };
}

test('a non-string is rejected and takes nothing off the budget', () => {
  for (const v of [undefined, null, 42, {}, ['a'], true]) {
    const { r, size } = sizeOf(v);
    assert.deepEqual(r, { ok: false, error: 'a pattern must be a string' });
    assert.equal(size, 0);
  }
});

test('an empty string is rejected', () => {
  const { r, size } = sizeOf('');
  assert.deepEqual(r, { ok: false, error: 'a pattern cannot be empty' });
  assert.equal(size, 0);
});

test('a pattern over the length limit is rejected, one at the limit is not', () => {
  const { r, size } = sizeOf('a'.repeat(MAX_PATTERN_LENGTH + 1));
  assert.equal(r.ok, false);
  assert.equal(r.error, 'the pattern is longer than ' + MAX_PATTERN_LENGTH + ' characters');
  assert.equal(size, 0);
  assert.equal(compileCustomPattern('a'.repeat(MAX_PATTERN_LENGTH)).ok, true);
});

test('a plain literal compiles with a fixed size of 3', () => {
  const { r, size } = sizeOf('example text');
  assert.equal(r.ok, true);
  assert.equal(r.error, undefined);
  assert.equal(size, 3);
  assert.equal(r.rule.source, 'example text');
  assert.equal(r.rule.test('An EXAMPLE TEXT here'), true);
  assert.equal(r.rule.test('other'), false);
});

test('a pattern with special characters compiles with its program size', () => {
  const { r, size } = sizeOf('ab[0-9]+');
  assert.equal(r.ok, true);
  assert.equal(r.error, undefined);
  assert.ok(size > 0);
  assert.equal(r.rule.test('xAB123'), true);
  assert.equal(r.rule.test('ab'), false);
  assert.equal(sizeOf('ab[0-9]+').size, size);
});

test('an unsupported feature gives ok false, a message and no size', () => {
  const { r, size } = sizeOf('(?=a)b');
  assert.equal(r.ok, false);
  assert.match(r.error, /lookahead/);
  assert.equal(r.rule, undefined);
  assert.equal(size, 0);
});

test('the same pattern compiled twice gives the same result', () => {
  for (const src of ['plain words', 'x[a-c]{2}', '(?<n>a)']) {
    const a = sizeOf(src);
    const b = sizeOf(src);
    assert.equal(a.r.ok, b.r.ok);
    assert.equal(a.r.error, b.r.error);
    assert.equal(a.size, b.size);
    if (a.r.ok) assert.strictEqual(a.r.rule, b.r.rule);
  }
});

test('a budget that is too small rejects a pattern and keeps the budget', () => {
  const budget = { left: 2 };
  const r = compileCustomPattern('plain words', budget);
  assert.equal(r.ok, false);
  assert.match(r.error, /too large together/);
  assert.equal(budget.left, 2);
});
