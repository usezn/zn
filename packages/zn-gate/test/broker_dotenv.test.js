'use strict';

// .env parsing keeps byte positions so only the value part is rewritten.

const test = require('node:test');
const assert = require('node:assert/strict');
const d = require('../lib/broker/dotenv');

test('plain, export and spaced assignments give exact value ranges', () => {
  const text = 'A=one\nexport B = two\n  C=three';
  const { entries } = d.parseDotenv(text);
  assert.deepEqual(entries.map((e) => [e.key, e.value, e.quote]), [['A', 'one', ''], ['B', 'two', ''], ['C', 'three', '']]);
  const lines = d.parseDotenv(text).lines;
  for (const e of entries) assert.equal(lines[e.lineIndex].slice(e.start, e.end), e.value);
});

test('comments, blank lines and invalid keys are skipped', () => {
  const { entries } = d.parseDotenv('# A=1\n\n1BAD=x\nno equals\nOK=1\n');
  assert.deepEqual(entries.map((e) => e.key), ['OK']);
});

test('quoted values exclude the quotes and ignore trailing text', () => {
  const { entries, lines } = d.parseDotenv('A="x y" # c\nB=\'q\'\nC=`b`\nD=""');
  assert.deepEqual(entries.map((e) => [e.value, e.quote]), [['x y', '"'], ['q', "'"], ['b', '`'], ['', '"']]);
  assert.equal(lines[entries[0].lineIndex].slice(entries[0].start, entries[0].end), 'x y');
});

test('escape sequences inside double quotes are left as written', () => {
  const { entries } = d.parseDotenv('A="a\\nb"');
  assert.equal(entries[0].value, 'a\\nb');
});

test('an unclosed quote is reported as multiline', () => {
  const { entries } = d.parseDotenv('A="first\nsecond"\n');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].multiline, true);
  assert.equal(entries[0].value, 'first');
});

test('unquoted values drop a trailing comment but keep # without a space', () => {
  const { entries } = d.parseDotenv('A=abc   # note\nB=a#b\nC=\n');
  assert.deepEqual(entries.map((e) => e.value), ['abc', 'a#b', '']);
});

test('CRLF separators are kept and not part of values', () => {
  const parsed = d.parseDotenv('A=1\r\nB=2\r\n');
  assert.deepEqual(parsed.entries.map((e) => e.value), ['1', '2']);
  assert.equal(d.applyEdits(parsed, []), 'A=1\r\nB=2\r\n');
});

test('non-string input is converted to text', () => {
  assert.deepEqual(d.parseDotenv(Buffer.from('A=1')).entries.map((e) => e.key), ['A']);
});

test('isSensitiveKey matches names case-insensitively', () => {
  for (const k of ['API_KEY', 'db_password', 'My_Token', 'DATABASE_URL', 'REDIS_URL', 'S3_URI', 'CONN_STR']) assert.equal(d.isSensitiveKey(k), true, k);
  for (const k of ['NAME', 'PORT', 'URL_BASE', 'DEBUG']) assert.equal(d.isSensitiveKey(k), false, k);
});

test('connectionPassword finds only the password of a URL', () => {
  const v = 'postgres://user:fakepw@db.example.com/app';
  const r = d.connectionPassword(v);
  assert.equal(v.slice(r.start, r.end), 'fakepw');
  assert.equal(d.connectionPassword('postgres://db.example.com/app'), null);
  assert.equal(d.connectionPassword('postgres://user@db.example.com/app'), null);
  assert.equal(d.connectionPassword('not a url'), null);
});

test('applyEdits rewrites several ranges on one line and leaves others', () => {
  const parsed = d.parseDotenv('# top\nA=aaaa\nB=bbbb\n');
  const a = parsed.entries[0];
  const out = d.applyEdits(parsed, [
    { lineIndex: a.lineIndex, start: a.start, end: a.start + 1, text: 'X' },
    { lineIndex: a.lineIndex, start: a.end - 1, end: a.end, text: 'YY' },
  ]);
  assert.equal(out, '# top\nA=XaaYY\nB=bbbb\n');
});

test('isShadowed: empty, short and non-sensitive values count as shadowed', () => {
  assert.equal(d.isShadowed(''), true);
  assert.equal(d.isShadowed('NAME=plain-value-here\nAPI_KEY=short'), true);
});

test('isShadowed: a real-looking secret is not shadowed, a marker is', () => {
  assert.equal(d.isShadowed('API_KEY=fake-secret-value-123'), false);
  assert.equal(d.isShadowed('API_KEY=__ZN_API_KEY__'), true);
});

test('isShadowed handles connection strings', () => {
  assert.equal(d.isShadowed('DATABASE_URL=postgres://u:__ZN_DB_PW__@db.example.com/x'), true);
  assert.equal(d.isShadowed('DATABASE_URL=postgres://u:fakepw123@db.example.com/x'), false);
  assert.equal(d.isShadowed('DATABASE_URL=postgres://db.example.com/x'), true);
});
