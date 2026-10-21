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

test('two secrets on consecutive lines are both redacted, each on its own', () => {
  const other = 'ghp_' + 'Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2';
  const out = rules.redactSecrets(KEY + '\n' + other).sanitized;
  assert.ok(!out.includes(KEY.slice(-12)) && !out.includes(other.slice(-12)), out);
  assert.equal(rules.redactSecrets(KEY + '\n' + other).detections.length, 2);
});

test('a wrapped value whose first line matches alone is redacted whole', () => {
  const second = 'Rs8tUv1wXy4zAb7cDe0f';
  const out = rules.redactSecrets('API_KEY=Ab3dEf6hIj9kLm2nOp5q\n' + second).sanitized;
  assert.ok(!out.includes(second), out);
});

test('a Stripe key wrapped after 28 characters is redacted whole', () => {
  const tail = 'Xy4zAb7cDe0f';
  const out = rules.redactSecrets('sk_' + 'live_' + 'Ab3dEf6hIj9kLm2nOp5qRs8tUv1w\n' + tail).sanitized;
  assert.ok(!out.includes(tail), out);
});

test('texts over 1 MiB are not joined across lines', () => {
  const big = 'x'.repeat((1 << 20) + 1) + '\nabcdefghijklmnopqrst';
  assert.equal(rules.invisibleView(big), null);
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

// The wrap breaks are found once per line break, not by matchAll over the whole text. Same result:
// compared with matchAll of the pattern in lib/rules.js on random texts made of the pieces that matter
// (runs of 10 token characters, spaces, tabs, CR, LF and NAME= or NAME: starts).
test('wrap breaks found per line break match matchAll of the pattern', () => {
  const src = require('fs').readFileSync(require.resolve('../lib/rules'), 'utf8');
  const re = new Function('return ' + src.match(/^const WRAP_BREAK_RE = (\/.*\/g);$/m)[1])();
  const parts = ['abcdefghij', 'KLMNOPQRST', '0123456789', 'ab_+/=-cd', 'ABCDE', '=', ' ', '\t', '\r', '\n', '\n', '\n', 'NAME=', 'key: ', 'x', '.'];
  let seed = 42;
  const rnd = (n) => {
    seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
    return (seed >>> 8) % n;
  };
  let joined = 0;
  for (let k = 0; k < 10000; k++) {
    let text = '';
    const len = 1 + rnd(40);
    for (let j = 0; j < len; j++) text += parts[rnd(parts.length)];
    const runs = [...text.matchAll(re)].map((m) => [m.index, m.index + m[0].length]);
    let clean = '';
    let pos = 0;
    for (const [s, e] of runs) {
      clean += text.slice(pos, s);
      pos = e;
    }
    clean += text.slice(pos);
    const view = rules.invisibleView(text);
    if (runs.length === 0) assert.equal(view, null, JSON.stringify(text));
    else {
      assert.equal(view.clean, clean, JSON.stringify(text));
      joined++;
    }
  }
  assert.ok(joined > 300, 'too few texts with a wrap break: ' + joined);
});
