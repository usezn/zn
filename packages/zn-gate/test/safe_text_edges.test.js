'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { isUnsafeText, hasUnsafeText } = require('../lib/safe-text');

test('empty input is safe', () => {
  assert.strictEqual(isUnsafeText(''), false);
  assert.strictEqual(hasUnsafeText(''), false);
  assert.strictEqual(hasUnsafeText({}), false);
  assert.strictEqual(hasUnsafeText([]), false);
});

test('non-string input is not treated as unsafe text', () => {
  for (const v of [undefined, null, 0, 12, true, {}]) assert.strictEqual(isUnsafeText(v), false);
});

test('NUL is unsafe but other control characters are not', () => {
  assert.strictEqual(isUnsafeText('a\u0000b'), true);
  assert.strictEqual(isUnsafeText('\u0000'), true);
  assert.strictEqual(isUnsafeText('tab\tnew\nline\rbell\u0007esc\u001b del\u007f'), false);
  assert.strictEqual(isUnsafeText('\u0080\u009f'), false);
});

test('NUL is found in object keys and nested values', () => {
  assert.strictEqual(hasUnsafeText({ 'k\u0000': 1 }), true);
  assert.strictEqual(hasUnsafeText({ a: [{ b: 'x\u0000' }] }), true);
  assert.strictEqual(hasUnsafeText({ a: [{ b: 'x\n' }] }), false);
});

test('long text is checked end to end', () => {
  const long = 'a'.repeat(1_000_000);
  assert.strictEqual(isUnsafeText(long), false);
  assert.strictEqual(isUnsafeText(long + '\u0000'), true);
  assert.strictEqual(isUnsafeText('\u0000' + long), true);
  assert.strictEqual(isUnsafeText(long + '\uD800'), true);
  assert.strictEqual(isUnsafeText(long + '\u{10000}'), true);
  assert.strictEqual(isUnsafeText('\u{1F600}'.repeat(100000)), false);
});

test('ordinary non-ASCII text is safe', () => {
  for (const s of ['café', '日本語', 'путь', '\u{1F600}', '\u{20000}', '�', '\u{10FFFD}']) {
    assert.strictEqual(isUnsafeText(s), false, JSON.stringify(s));
  }
});

test('lone surrogates are unsafe, valid pairs are not', () => {
  assert.strictEqual(isUnsafeText('\uD83D'), true);
  assert.strictEqual(isUnsafeText('\uDE00'), true);
  assert.strictEqual(isUnsafeText('\uDE00\uD83D'), true);
  assert.strictEqual(isUnsafeText('😀'), false);
});

test('non-characters and the unsafe code points are unsafe', () => {
  for (const s of ['￾', '￿', '﷐', '﷯', '\u{10000}', '\u{1FFFE}', '\u{10FFFF}']) {
    assert.strictEqual(isUnsafeText(s), true, JSON.stringify(s));
  }
  assert.strictEqual(isUnsafeText('﷏ﷰ'), false);
});

test('deep nesting is refused', () => {
  let v = 'x';
  for (let i = 0; i < 70; i++) v = [v];
  assert.strictEqual(hasUnsafeText(v), true);
});
