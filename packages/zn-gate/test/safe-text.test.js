'use strict';

// lib/safe-text.js: text that must not reach a file, process or network call (Windows libuv abort on some
// code points, NUL, lone surrogates, non-characters). Unsafe text makes the hook deny; these tests check
// which strings count as unsafe.

const test = require('node:test');
const assert = require('node:assert/strict');
const { isUnsafeText, hasUnsafeText } = require('../lib/safe-text');

const MB = 1024 * 1024;

test('ordinary text, paths and commands are safe', () => {
  for (const s of ['', 'hello', 'git status --short', '/home/me/project', 'C:\\Users\\me\\x', 'café 日本語', 'ok 😀']) {
    assert.equal(isUnsafeText(s), false, s);
  }
});

test('control characters other than NUL are not refused', () => {
  assert.equal(isUnsafeText('tab\tnew\nline\rcr\u0001bell\u001b'), false);
});

test('a NUL is refused', () => {
  assert.equal(isUnsafeText('a\u0000b'), true);
  assert.equal(isUnsafeText('\u0000'), true);
});

test('U+10000 and the last two code points of each plane are refused', () => {
  assert.equal(isUnsafeText('\uD800\uDC00'), true); // U+10000
  assert.equal(isUnsafeText('\uD83F\uDFFE'), true); // U+1FFFE
  assert.equal(isUnsafeText('\uD83F\uDFFF'), true); // U+1FFFF
  assert.equal(isUnsafeText('\uDBFF\uDFFF'), true); // U+10FFFF
});

test('the code points next to them are fine', () => {
  assert.equal(isUnsafeText('\uD800\uDC01'), false); // U+10001
  assert.equal(isUnsafeText('\uDBFF\uDFFD'), false); // U+10FFFD
  assert.equal(isUnsafeText('\uD83F\uDFFD'), false); // U+1FFFD
  assert.equal(isUnsafeText('\uD83E\uDFFE'), false); // U+1DFFE: not the last two of its plane
});

test('lone surrogates are refused, and a valid pair is not', () => {
  assert.equal(isUnsafeText('\uD800'), true); // high at the end
  assert.equal(isUnsafeText('\uD800a'), true); // high with no low after it
  assert.equal(isUnsafeText('\uDC00'), true); // low at the start
  assert.equal(isUnsafeText('\uD800\uDC00\uDC00'), true); // a second low after a pair
  assert.equal(isUnsafeText('\uD83D\uDE00'), false); // U+1F600, a valid pair
});

test('non-characters are refused', () => {
  for (const s of ['\uFDD0', '\uFDEF', '\uFFFE', '\uFFFF']) assert.equal(isUnsafeText(s), true, escape(s));
  assert.equal(isUnsafeText('\uFDF0'), false);
  assert.equal(isUnsafeText('\uFFFD'), false); // the replacement character is a real character
});

test('non-string values are not unsafe text', () => {
  assert.equal(isUnsafeText(undefined), false);
  assert.equal(isUnsafeText(42), false);
  assert.equal(isUnsafeText(null), false);
});

test('a 1 MB string is checked within the time bound', () => {
  const t0 = Date.now();
  assert.equal(isUnsafeText('a'.repeat(MB)), false);
  assert.equal(isUnsafeText('\uD83D\uDE00'.repeat(MB / 2)), false); // U+1F600 pairs, not U+10000
  assert.equal(isUnsafeText('\uDC00'.repeat(MB)), true);
  assert.ok(Date.now() - t0 < 2000, 'took too long');
});

test('hasUnsafeText looks at keys and values at any depth', () => {
  assert.equal(hasUnsafeText({ a: { b: ['ok', { c: 'bad\u0000' }] } }), true);
  assert.equal(hasUnsafeText({ ['bad\u0000key']: 1 }), true);
  assert.equal(hasUnsafeText({ a: ['x', 1, true, null, { b: 'fine' }] }), false);
  assert.equal(hasUnsafeText('plain'), false);
  assert.equal(hasUnsafeText(null), false);
  assert.equal(hasUnsafeText(3), false);
});

test('hasUnsafeText refuses nesting beyond 64 levels, and a circular value', () => {
  let deep = 'ok';
  for (let i = 0; i < 10; i++) deep = { x: deep };
  assert.equal(hasUnsafeText(deep), false);
  let tooDeep = 'ok';
  for (let i = 0; i < 70; i++) tooDeep = [tooDeep];
  assert.equal(hasUnsafeText(tooDeep), true);
  const circular = {};
  circular.self = circular;
  assert.equal(hasUnsafeText(circular), true);
});

function escape(s) {
  return Array.from(s, (c) => 'U+' + c.charCodeAt(0).toString(16)).join(' ');
}
