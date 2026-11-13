'use strict';

// Character classes of the linear matcher, checked through compiled patterns:
// \w and \b (isWord), \d (isDigit), \s (isWs) and `.` (isLineEnd).

const test = require('node:test');
const assert = require('node:assert/strict');
const { compileCustomPattern } = require('../lib/linear-regex');

function matcher(source) {
  const res = compileCustomPattern(source);
  assert.equal(res.ok, true, res.error);
  return (text) => res.rule.test(text);
}

test('\\w accepts ASCII letters, digits and underscore only', () => {
  const only = matcher('^\\w$');
  for (const ch of ['a', 'z', 'A', 'Z', '0', '9', '_']) assert.equal(only(ch), true, ch);
  for (const ch of ['-', ' ', '/', '@', '[', '`', '{', '\u00e9', '\u00df', '\u4e2d', '\u0661']) {
    assert.equal(only(ch), false, JSON.stringify(ch));
  }
});

test('\\W is the negation of \\w', () => {
  const non = matcher('^\\W$');
  assert.equal(non('a'), false);
  assert.equal(non('_'), false);
  assert.equal(non('-'), true);
  assert.equal(non('\u00e9'), true);
});

test('\\b treats ASCII word characters as the word side', () => {
  assert.equal(matcher('\\bcat\\b')('a cat sat'), true);
  assert.equal(matcher('\\bcat\\b')('concat'), false);
  assert.equal(matcher('\\bcat\\b')('cat_1'), false);
  assert.equal(matcher('\\bcat\\b')('cat9'), false);
  assert.equal(matcher('\\bcat\\b')('cat-food'), true);
  assert.equal(matcher('\\bcat\\b')('\tcat\n'), true);
});

test('\\b sees a non-ASCII letter as a non-word character', () => {
  assert.equal(matcher('\\bcat\\b')('cat\u00e9'), true);
  assert.equal(matcher('\\Bcat')('\u00e9cat'), false);
});

test('\\d accepts ASCII digits only', () => {
  const only = matcher('^\\d$');
  for (const ch of '0123456789') assert.equal(only(ch), true, ch);
  for (const ch of ['a', '_', '/', ':', ' ', '\u0661', '\uff11']) {
    assert.equal(only(ch), false, JSON.stringify(ch));
  }
  assert.equal(matcher('^\\D$')('5'), false);
  assert.equal(matcher('^\\D$')('x'), true);
});

test('\\s accepts tabs, line breaks and Unicode spaces', () => {
  const ws = matcher('^\\s$');
  for (const ch of [' ', '\t', '\n', '\r', '\v', '\f', '\u00a0', '\u2003', '\u2028', '\u2029', '\u3000', '\ufeff']) {
    assert.equal(ws(ch), true, JSON.stringify(ch));
  }
  for (const ch of ['a', '0', '_', '\u00e9', '\u200b', '\u0085']) {
    assert.equal(ws(ch), false, JSON.stringify(ch));
  }
});

test('\\S is the negation of \\s', () => {
  const non = matcher('^\\S$');
  assert.equal(non(' '), false);
  assert.equal(non('\t'), false);
  assert.equal(non('\u00a0'), false);
  assert.equal(non('a'), true);
  assert.equal(non('\u200b'), true);
});

test('. does not match line ends but matches other characters', () => {
  const dot = matcher('^.$');
  for (const ch of ['\n', '\r', '\u2028', '\u2029']) assert.equal(dot(ch), false, JSON.stringify(ch));
  for (const ch of ['a', ' ', '\t', '_', '\u00e9', '\u4e2d', '\u0085']) {
    assert.equal(dot(ch), true, JSON.stringify(ch));
  }
});

test('. cannot cross a line break inside a pattern', () => {
  assert.equal(matcher('a.b')('a-b'), true);
  assert.equal(matcher('a.b')('a\nb'), false);
  assert.equal(matcher('a.b')('a\r\nb'), false);
});
