'use strict';

// Rules that the other rules tests left open: the invisible-character count
// (tag characters, lone surrogates), compatibility folding outside the
// fullwidth range, and the length at which a mixed-case value reads as random.
// Every value is made up.

const test = require('node:test');
const assert = require('node:assert/strict');
const { tooInvisible, normalizeInput, isNonSecretValue, MIN_INVISIBLE_CHECK_CHARS } = require('../lib/rules');

const ZW = '​';

test('the tag character U+E007F counts as invisible', () => {
  // Surrogate pair DB40 DC7F, alone and not part of a flag sequence.
  const text = '\u{E007F}'.repeat(70000);
  assert.ok(text.length - 70000 >= MIN_INVISIBLE_CHECK_CHARS);
  assert.equal(tooInvisible([text]), true);
  assert.equal(tooInvisible(['\u{E007F}'.repeat(10) + 'a'.repeat(MIN_INVISIBLE_CHECK_CHARS)]), false);
});

test('a lone low surrogate after a normal character is one unit of length, not a pair', () => {
  // Length counts code points. Here it is exactly the minimum, with more than half of it invisible.
  const filler = MIN_INVISIBLE_CHECK_CHARS - 2 - 40000;
  const text = 'é\udc00' + ZW.repeat(40000) + 'x'.repeat(filler);
  assert.equal(text.length, MIN_INVISIBLE_CHECK_CHARS);
  assert.equal(tooInvisible([text]), true);
  // One character less than the minimum is not checked.
  assert.equal(tooInvisible([text.slice(0, -1)]), false);
});

test('compatibility folding maps the long s, the Kelvin sign and circled digits to their ASCII forms', () => {
  assert.equal(normalizeInput('xſy').stripped, 'xsy');
  assert.equal(normalizeInput('Kſ').stripped, 'Ks');
  assert.equal(normalizeInput('①②').stripped, '12');
  assert.equal(normalizeInput('ﬁle').stripped, 'file');
  // The fullwidth range still folds by offset.
  assert.equal(normalizeInput('ＡＢ１').stripped, 'AB1');
});

test('a mixed-case value is random-looking from 20 letters and digits, not from 19', () => {
  // Two word-like parts (a capitalised word and a number), so only the length rule can make it look random.
  const w19 = 'Abcdefghijklmnopq12';
  const w20 = 'Abcdefghijklmnopqr12';
  assert.equal(w19.length, 19);
  assert.equal(w20.length, 20);
  assert.equal(isNonSecretValue(w19 + '.json', 'API_KEY'), true, '19 characters read as a file name');
  assert.equal(isNonSecretValue(w20 + '.json', 'API_KEY'), false, '20 characters read as a random value');
  assert.equal(isNonSecretValue('/opt/app/' + w19, 'API_KEY'), true);
  assert.equal(isNonSecretValue('/opt/app/' + w20, 'API_KEY'), false);
});
