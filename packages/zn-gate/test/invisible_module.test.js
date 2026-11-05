'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const inv = require('../lib/invisible');

test('BMP_CLASS matches listed characters and not ordinary ones', () => {
  const re = new RegExp('^[' + inv.BMP_CLASS + ']$');
  for (const cp of [0x200B, 0x200D, 0x2060, 0xFEFF, 0x00AD, 0xFE00, 0xFE0F, 0x061C, 0x180E, 0x200E, 0x200F, 0x115F, 0x1160, 0x3164, 0xFFA0]) {
    assert.ok(re.test(String.fromCodePoint(cp)), cp.toString(16));
  }
  for (const ch of ['a', ' ', ' ', '‌'.replace('‌', '‐'), '︐']) {
    assert.ok(!re.test(ch), JSON.stringify(ch));
  }
});

test('ASTRAL_CLASS matches tag and supplementary variation selector ranges only', () => {
  const re = new RegExp('^[' + inv.ASTRAL_CLASS + ']$', 'u');
  for (const cp of [0xE0000, 0xE0041, 0xE007F, 0xE0100, 0xE01EF]) {
    assert.ok(re.test(String.fromCodePoint(cp)), cp.toString(16));
  }
  for (const cp of [0xE0080, 0xE00FF, 0xE01F0, 0x1F600]) {
    assert.ok(!re.test(String.fromCodePoint(cp)), cp.toString(16));
  }
});

test('spaceInvisibleForMatch uses one space per invisible code point', () => {
  const tag = String.fromCodePoint(0xE0041);
  assert.equal(inv.spaceInvisibleForMatch('a​b'), 'a b');
  assert.equal(inv.spaceInvisibleForMatch('a' + tag + 'b'), 'a b');
  assert.equal(inv.spaceInvisibleForMatch('a​' + tag + 'b'), 'a  b');
});

test('spaceInvisibleForMatch differs from spaceInvisible only in astral width', () => {
  const tag = String.fromCodePoint(0xE0041);
  assert.equal(inv.spaceInvisible('a' + tag + 'b').length, 4);
  assert.equal(inv.spaceInvisibleForMatch('a' + tag + 'b').length, 3);
  assert.equal(inv.spaceInvisible('a​b'), inv.spaceInvisibleForMatch('a​b'));
});

test('spaceInvisibleForMatch leaves plain text and empty strings unchanged', () => {
  assert.equal(inv.spaceInvisibleForMatch(''), '');
  assert.equal(inv.spaceInvisibleForMatch('plain text'), 'plain text');
  assert.equal(inv.spaceInvisibleForMatch('café \u{1F600}'), 'café \u{1F600}');
});
