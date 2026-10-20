'use strict';
// Secrets printed across several lines (wrapped every 10 or 20 characters) are
// redacted whole, and short words or NAME= lines after them are left alone.
const test = require('node:test');
const assert = require('node:assert/strict');
const rules = require('../lib/rules');

// Fictitious GitHub token: "ghp_" + 36 characters.
const KEY = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
const wrap = (s, n) => s.match(new RegExp('.{1,' + n + '}', 'g')).join('\n');

for (const n of [20, 10]) {
  test(`a token wrapped every ${n} characters is redacted whole`, () => {
    const out = rules.redactSecrets('token:\n' + wrap(KEY, n) + '\n').sanitized;
    assert.match(out, /\[REDACTED_GITHUB_TOKEN\]/);
    for (const part of wrap(KEY, n).split('\n')) assert.ok(!out.includes(part), part);
  });
}

test('a wrapped token with CRLF and indentation is redacted whole', () => {
  const text = '  ' + KEY.slice(0, 20) + '\r\n  ' + KEY.slice(20) + '\r\n';
  const out = rules.redactSecrets(text).sanitized;
  assert.ok(!out.includes(KEY.slice(20)), out);
});

test('a short word on the next line is kept', () => {
  const out = rules.redactSecrets('token:\n' + wrap(KEY, 20) + '\nend').sanitized;
  assert.ok(out.endsWith('\nend'), out);
});

test('a NAME= line after a long value is not joined to it', () => {
  const text = 'ALPHA_VALUE=abcdefghijklmnop\nNEXT_SETTING_NAME=abcdefghij';
  assert.equal(rules.redactSecrets(text).sanitized, text);
});

test('ordinary text across lines is unchanged', () => {
  const text = 'The quick brown fox\njumps over the lazy dog\nand_snake_case_names\nkeep_their_lines';
  assert.equal(rules.redactSecrets(text).sanitized, text);
});

test('invisibleView maps a wrap break back to the original text', () => {
  const text = 'abcdefghij\nklmnopqrst';
  const view = rules.invisibleView(text);
  assert.equal(view.clean, 'abcdefghijklmnopqrst');
  assert.equal(view.map[10], 11);
  assert.equal(view.map[view.clean.length], text.length);
  assert.equal(rules.invisibleView('short\nlines'), null);
});
