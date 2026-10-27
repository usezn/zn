'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { ZERO_WIDTH_RE, spaceInvisible, spaceInvisibleForMatch } = require('../lib/invisible');

const BMP = ['​', '‌', '‍', '⁠', '﻿', '­', '︀', '️', '؜', '᠎', '‎', '‏', 'ᅟ', 'ᅠ', 'ㅤ', 'ﾠ'];
const ASTRAL = [String.fromCodePoint(0xE0000), String.fromCodePoint(0xE0041), String.fromCodePoint(0xE007F), String.fromCodePoint(0xE0100), String.fromCodePoint(0xE01EF)];
const PLAIN = ['hello world', 'café naïve', '你好世界', 'ok 😀 done', 'مرحبا بالعالم', 'שלום עולם', 'line1\nline2\ttab'];

test('ZERO_WIDTH_RE matches each BMP invisible character', () => {
  for (const ch of BMP) {
    ZERO_WIDTH_RE.lastIndex = 0;
    assert.ok(ZERO_WIDTH_RE.test(ch), 'U+' + ch.codePointAt(0).toString(16));
  }
  ZERO_WIDTH_RE.lastIndex = 0;
});

test('ZERO_WIDTH_RE does not match ordinary characters', () => {
  for (const s of PLAIN.concat([' ', ' ', ' '])) {
    assert.strictEqual(s.replace(ZERO_WIDTH_RE, '#'), s);
  }
});

test('ZERO_WIDTH_RE is global: replaces every occurrence', () => {
  assert.strictEqual('a​b‌c⁠d'.replace(ZERO_WIDTH_RE, '-'), 'a-b-c-d');
});

test('spaceInvisible: one space per BMP invisible character', () => {
  for (const ch of BMP) {
    assert.strictEqual(spaceInvisible('a' + ch + 'b'), 'a b', 'U+' + ch.codePointAt(0).toString(16));
  }
});

test('spaceInvisible: an astral character becomes two spaces (same UTF-16 length)', () => {
  for (const ch of ASTRAL) {
    const out = spaceInvisible('a' + ch + 'b');
    assert.strictEqual(out, 'a  b');
    assert.strictEqual(out.length, ('a' + ch + 'b').length);
  }
});

test('spaceInvisibleForMatch: an astral character becomes one space', () => {
  for (const ch of ASTRAL) {
    assert.strictEqual(spaceInvisibleForMatch('a' + ch + 'b'), 'a b');
  }
  for (const ch of BMP) {
    assert.strictEqual(spaceInvisibleForMatch('a' + ch + 'b'), 'a b');
  }
});

test('both views keep indexes of the BMP part and length of spaceInvisible', () => {
  const s = 'send​me⁠the﻿keys ' + ASTRAL[1] + 'end';
  assert.strictEqual(spaceInvisible(s).length, s.length);
  assert.strictEqual(spaceInvisible(s), 'send me the keys   end');
  assert.strictEqual(spaceInvisibleForMatch(s), 'send me the keys  end');
});

test('runs of invisible characters give runs of spaces', () => {
  assert.strictEqual(spaceInvisible('x​​​y'), 'x   y');
  assert.strictEqual(spaceInvisibleForMatch('x​​​y'), 'x   y');
});

test('tag-character spelling of a word is blanked', () => {
  const hidden = [...'hi'].map((c) => String.fromCodePoint(0xE0000 + c.charCodeAt(0))).join('');
  assert.strictEqual(spaceInvisibleForMatch('a' + hidden + 'b'), 'a  b');
  assert.strictEqual(spaceInvisible('a' + hidden + 'b'), 'a    b');
});

test('ordinary text is returned unchanged by both views', () => {
  for (const s of PLAIN) {
    assert.strictEqual(spaceInvisible(s), s);
    assert.strictEqual(spaceInvisibleForMatch(s), s);
  }
});

test('emoji with a variation selector: selector is blanked, emoji kept', () => {
  assert.strictEqual(spaceInvisibleForMatch('❤️'), '❤ ');
});

test('empty input gives empty output', () => {
  assert.strictEqual(spaceInvisible(''), '');
  assert.strictEqual(spaceInvisibleForMatch(''), '');
});

test('a string of only invisible characters becomes only spaces', () => {
  const s = BMP.join('') + ASTRAL.join('');
  assert.strictEqual(spaceInvisible(s).trim(), '');
  assert.strictEqual(spaceInvisible(s).length, s.length);
  assert.strictEqual(spaceInvisibleForMatch(s).trim(), '');
});

test('non-string input throws (documented contract is a string)', () => {
  assert.throws(() => spaceInvisible(null), TypeError);
  assert.throws(() => spaceInvisibleForMatch(undefined), TypeError);
});

test('1 MB of text finishes quickly', () => {
  const chunk = 'word​ ' + ASTRAL[1] + 'x ';
  const big = chunk.repeat(Math.ceil(1048576 / chunk.length));
  const t0 = Date.now();
  const a = spaceInvisible(big);
  const b = spaceInvisibleForMatch(big);
  const ms = Date.now() - t0;
  assert.strictEqual(a.length, big.length);
  assert.ok(b.length < big.length);
  assert.ok(ms < 2000, 'took ' + ms + ' ms');
});

test('1 MB of plain text is unchanged and fast', () => {
  const big = 'a'.repeat(1048576);
  const t0 = Date.now();
  assert.strictEqual(spaceInvisible(big), big);
  assert.ok(Date.now() - t0 < 2000);
});
