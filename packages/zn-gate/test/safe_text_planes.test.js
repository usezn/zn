'use strict';

// Direct tests of isUnsafeText and hasUnsafeText: code points outside the first plane, lone surrogates,
// keys, nesting depth and values that are not strings. Text is built from code points, so this file holds
// no malformed text itself.

const test = require('node:test');
const assert = require('node:assert/strict');
const { isUnsafeText, hasUnsafeText } = require('../lib/safe-text');

const cp = (n) => 'a' + String.fromCodePoint(n) + 'b';
const unit = (n) => 'a' + String.fromCharCode(n) + 'b';

test('isUnsafeText refuses lone surrogates', () => {
  assert.equal(isUnsafeText(unit(0xD800)), true);
  assert.equal(isUnsafeText(unit(0xDBFF)), true);
  assert.equal(isUnsafeText(unit(0xDC00)), true);
  assert.equal(isUnsafeText(unit(0xDFFF)), true);
  assert.equal(isUnsafeText(String.fromCharCode(0xD800)), true);
  assert.equal(isUnsafeText(String.fromCharCode(0xDC00, 0xD800)), true);
});

test('isUnsafeText refuses U+10000, U+1FFFE, U+1FFFF and U+10FFFF', () => {
  for (const n of [0x10000, 0x1FFFE, 0x1FFFF, 0x10FFFF]) {
    assert.equal(isUnsafeText(cp(n)), true, n.toString(16));
  }
});

test('isUnsafeText accepts other astral characters and plain text', () => {
  for (const n of [0x10001, 0x1F600, 0x1FFFD, 0x20000, 0x10FFFD]) {
    assert.equal(isUnsafeText(cp(n)), false, n.toString(16));
  }
  assert.equal(isUnsafeText(''), false);
  assert.equal(isUnsafeText('plain text'), false);
});

test('isUnsafeText finds an unsafe pair after a safe one', () => {
  assert.equal(isUnsafeText(cp(0x1F600) + cp(0x10FFFF)), true);
});

test('isUnsafeText is false for values that are not strings', () => {
  for (const v of [undefined, null, 0, 1, true, {}, [], [cp(0x10FFFF)], Symbol('x'), 10n]) {
    assert.equal(isUnsafeText(v), false);
  }
});

test('hasUnsafeText checks strings, values and keys', () => {
  assert.equal(hasUnsafeText(cp(0x10000)), true);
  assert.equal(hasUnsafeText('fine'), false);
  assert.equal(hasUnsafeText({ a: unit(0xD800) }), true);
  assert.equal(hasUnsafeText([1, ['x', cp(0x1FFFE)]]), true);
  assert.equal(hasUnsafeText({ ['k' + String.fromCharCode(0xDC00)]: 'fine' }), true);
  assert.equal(hasUnsafeText({ [cp(0x10FFFF)]: 1 }), true);
  assert.equal(hasUnsafeText({ ok: ['fine', { also: 'fine' }] }), false);
});

test('hasUnsafeText is false for values that are not strings or containers', () => {
  for (const v of [undefined, null, 0, 42, NaN, true, false, 10n, Symbol('x')]) {
    assert.equal(hasUnsafeText(v), false);
  }
  assert.equal(hasUnsafeText({ a: 1, b: null, c: false, d: [] }), false);
});

function nest(levels, leaf) {
  let v = leaf;
  for (let i = 0; i < levels; i++) v = [v];
  return v;
}

test('hasUnsafeText reads 65 nested containers and refuses 66', () => {
  // The outermost container is read at depth 0 and the check is "depth > 64", so the 65th is the last allowed.
  assert.equal(hasUnsafeText(nest(64, 'fine')), false);
  assert.equal(hasUnsafeText(nest(65, 'fine')), false);
  assert.equal(hasUnsafeText(nest(66, 'fine')), true);
  assert.equal(hasUnsafeText(nest(64, [])), false);
  assert.equal(hasUnsafeText(nest(65, [])), true);
});

test('hasUnsafeText still finds unsafe text at the deepest allowed level', () => {
  assert.equal(hasUnsafeText(nest(65, cp(0x10FFFF))), true);
});

test('hasUnsafeText applies the depth limit to objects too', () => {
  const obj = (levels) => {
    let v = 'fine';
    for (let i = 0; i < levels; i++) v = { k: v };
    return v;
  };
  assert.equal(hasUnsafeText(obj(65)), false);
  assert.equal(hasUnsafeText(obj(66)), true);
});
