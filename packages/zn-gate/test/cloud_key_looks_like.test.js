'use strict';
const test = require('node:test');
const assert = require('node:assert');

const { looksLikeZnKey } = require('../lib/cloud-key');

const fake = (total) => 'zn_' + 'x'.repeat(total - 3);

test('looksLikeZnKey accepts zn_ keys from 16 to 256 characters', () => {
  assert.strictEqual(looksLikeZnKey(fake(16)), true);
  assert.strictEqual(looksLikeZnKey(fake(40)), true);
  assert.strictEqual(looksLikeZnKey(fake(256)), true);
});

test('looksLikeZnKey ignores surrounding whitespace', () => {
  assert.strictEqual(looksLikeZnKey('  ' + fake(20) + '\n'), true);
});

test('looksLikeZnKey rejects values shorter than 16 or longer than 256 characters', () => {
  assert.strictEqual(looksLikeZnKey('zn_xxxxx'), false);
  assert.strictEqual(looksLikeZnKey(fake(15)), false);
  assert.strictEqual(looksLikeZnKey(fake(257)), false);
});

test('looksLikeZnKey rejects characters outside the allowed set', () => {
  assert.strictEqual(looksLikeZnKey('zn_xxxxxxxxxxxx xxxxxxxx'), false);
  assert.strictEqual(looksLikeZnKey('zn_xxxxxxxxxxxx!xxxxxxxx'), false);
});

test('looksLikeZnKey rejects a value without the zn_ prefix', () => {
  assert.strictEqual(looksLikeZnKey('x'.repeat(20)), false);
  assert.strictEqual(looksLikeZnKey('ZN_' + 'x'.repeat(20)), false);
});

test('looksLikeZnKey rejects empty and non-string values', () => {
  for (const v of ['', undefined, null, 1234567890123456, {}, { key: fake(20) }]) {
    assert.strictEqual(looksLikeZnKey(v), false);
  }
});
