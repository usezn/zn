'use strict';

// Each character class in lib/invisible.js matches the characters it names and
// does not match letters, digits or a plain space.

const test = require('node:test');
const assert = require('node:assert/strict');
const { BMP_CLASS, ASTRAL_CLASS } = require('../lib/invisible');

const bmp = new RegExp('[' + BMP_CLASS + ']', 'u');
const astral = new RegExp('[' + ASTRAL_CLASS + ']', 'u');
const cp = (n) => String.fromCodePoint(n);

const BMP_NAMED = [
  0x200B, 0x200C, 0x200D, 0x2060, 0xFEFF, 0x00AD, 0xFE00, 0xFE0F, 0x061C,
  0x180E, 0x200E, 0x200F, 0x115F, 0x1160, 0x3164, 0xFFA0,
];

const PLAIN = ['a', 'Z', 'm', '0', '9', ' ', '\t', '\n', 'é', 'ß', '中', '-', '_'];

test('BMP_CLASS matches every character it names', () => {
  for (const n of BMP_NAMED) {
    assert.ok(bmp.test(cp(n)), 'U+' + n.toString(16));
  }
});

test('BMP_CLASS covers the whole zero-width and variation selector ranges', () => {
  for (let n = 0x200B; n <= 0x200D; n++) assert.ok(bmp.test(cp(n)));
  for (let n = 0xFE00; n <= 0xFE0F; n++) assert.ok(bmp.test(cp(n)));
});

test('BMP_CLASS does not match characters just outside its ranges', () => {
  for (const n of [0x200A, 0x2010, 0xFDFF, 0xFE10, 0xFEFE, 0x2061]) {
    assert.ok(!bmp.test(cp(n)), 'U+' + n.toString(16));
  }
});

test('BMP_CLASS does not match letters, digits or a plain space', () => {
  for (const ch of PLAIN) assert.ok(!bmp.test(ch), JSON.stringify(ch));
});

test('ASTRAL_CLASS matches tag characters and supplementary variation selectors', () => {
  for (const n of [0xE0000, 0xE0001, 0xE0020, 0xE007F, 0xE0100, 0xE0150, 0xE01EF]) {
    assert.ok(astral.test(cp(n)), 'U+' + n.toString(16));
  }
});

test('ASTRAL_CLASS does not match characters just outside its ranges', () => {
  for (const n of [0xDFFFF, 0xE0080, 0xE00FF, 0xE01F0, 0x1F600]) {
    assert.ok(!astral.test(cp(n)), 'U+' + n.toString(16));
  }
});

test('ASTRAL_CLASS does not match letters, digits, a plain space or BMP invisibles', () => {
  for (const ch of PLAIN) assert.ok(!astral.test(ch), JSON.stringify(ch));
  for (const n of BMP_NAMED) assert.ok(!astral.test(cp(n)));
});

test('BMP_CLASS does not match astral characters', () => {
  assert.ok(!bmp.test(cp(0xE0041)));
  assert.ok(!bmp.test(cp(0xE0100)));
});
