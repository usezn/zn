'use strict';

// Edge cases for isSensitiveKey and applyEdits in the .env helper.

const test = require('node:test');
const assert = require('node:assert/strict');
const d = require('../lib/broker/dotenv');

test('isSensitiveKey matches common names in any case', () => {
  for (const k of ['API_KEY', 'api_key', 'Secret', 'GITHUB_TOKEN', 'DB_PASS', 'PWD', 'AWS_CREDENTIALS', 'OAUTH', 'SENTRY_DSN', 'DATABASE_URL', 'CONN_STR']) {
    assert.equal(d.isSensitiveKey(k), true, k);
  }
});

test('isSensitiveKey is false for empty and plain names', () => {
  for (const k of ['', 'HOME', 'PORT', 'NODE_ENV', 'DEBUG']) {
    assert.equal(d.isSensitiveKey(k), false, k);
  }
});

test('isSensitiveKey treats _URL and _URI as sensitive only at the end', () => {
  assert.equal(d.isSensitiveKey('REDIS_URL'), true);
  assert.equal(d.isSensitiveKey('CALLBACK_URI'), true);
  assert.equal(d.isSensitiveKey('REDIS_URL_PUBLIC'), false);
  assert.equal(d.isSensitiveKey('URL'), false);
});

test('isSensitiveKey coerces non-string input without throwing', () => {
  assert.equal(d.isSensitiveKey(undefined), false);
  assert.equal(d.isSensitiveKey(null), false);
  assert.equal(d.isSensitiveKey(123), false);
  assert.equal(d.isSensitiveKey({ toString: () => 'MY_TOKEN' }), true);
});

test('applyEdits with no edits returns the original text', () => {
  for (const text of ['', 'A=1', 'A=1\r\nB=2\n']) {
    assert.equal(d.applyEdits(d.parseDotenv(text), []), text);
  }
});

test('applyEdits does not mutate the parsed lines', () => {
  const parsed = d.parseDotenv('A=one\n');
  const before = parsed.lines.slice();
  const e = parsed.entries[0];
  d.applyEdits(parsed, [{ lineIndex: e.lineIndex, start: e.start, end: e.end, text: 'X' }]);
  assert.deepEqual(parsed.lines, before);
});

test('applyEdits keeps CRLF separators and neighbouring lines', () => {
  const parsed = d.parseDotenv('A=one\r\nB=two\r\n');
  const e = parsed.entries[1];
  const out = d.applyEdits(parsed, [{ lineIndex: e.lineIndex, start: e.start, end: e.end, text: 'TWO' }]);
  assert.equal(out, 'A=one\r\nB=TWO\r\n');
});

test('applyEdits applies several edits on one line regardless of order', () => {
  const parsed = { lines: ['abcdef'], entries: [] };
  const edits = [
    { lineIndex: 0, start: 0, end: 1, text: 'X' },
    { lineIndex: 0, start: 4, end: 6, text: 'YYY' },
  ];
  assert.equal(d.applyEdits(parsed, edits), 'XbcdYYY');
  assert.equal(d.applyEdits(parsed, edits.slice().reverse()), 'XbcdYYY');
});

test('applyEdits supports insertion, deletion and quoted empty values', () => {
  const parsed = d.parseDotenv('A=""\nB=abc\n');
  const [a, b] = parsed.entries;
  assert.equal(a.start, a.end);
  const out = d.applyEdits(parsed, [
    { lineIndex: a.lineIndex, start: a.start, end: a.end, text: 'v' },
    { lineIndex: b.lineIndex, start: b.start, end: b.end, text: '' },
  ]);
  assert.equal(out, 'A="v"\nB=\n');
});

test('applyEdits throws for an edit on a line that does not exist', () => {
  const parsed = d.parseDotenv('A=1');
  assert.throws(() => d.applyEdits(parsed, [{ lineIndex: 5, start: 0, end: 0, text: 'x' }]), TypeError);
});

test('applyEdits clamps out-of-range offsets like String.slice', () => {
  const parsed = { lines: ['abc'], entries: [] };
  assert.equal(d.applyEdits(parsed, [{ lineIndex: 0, start: 1, end: 99, text: 'Z' }]), 'aZ');
  assert.equal(d.applyEdits(parsed, [{ lineIndex: 0, start: 3, end: 3, text: '!' }]), 'abc!');
});
