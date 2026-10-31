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

function editValue(text, key, replacement) {
  const parsed = d.parseDotenv(text);
  const e = parsed.entries.find((x) => x.key === key);
  return d.applyEdits(parsed, [{ lineIndex: e.lineIndex, start: e.start, end: e.end, text: replacement }]);
}

test('applyEdits edits the first, a middle and the last line', () => {
  const text = '# header\nA=one\nB=two\nC=three';
  assert.equal(editValue(text, 'A', 'X'), '# header\nA=X\nB=two\nC=three');
  assert.equal(editValue(text, 'B', 'X'), '# header\nA=one\nB=X\nC=three');
  assert.equal(editValue(text, 'C', 'X'), '# header\nA=one\nB=two\nC=X');
});

test('applyEdits keeps a trailing newline on the last line', () => {
  assert.equal(editValue('A=one\nB=two\n', 'B', 'X'), 'A=one\nB=X\n');
});

test('applyEdits keeps CRLF separators on edited and untouched lines', () => {
  const text = 'A=one\r\nB=two\r\nC=three\r\n';
  assert.equal(editValue(text, 'A', 'X'), 'A=X\r\nB=two\r\nC=three\r\n');
  assert.equal(editValue(text, 'B', 'X'), 'A=one\r\nB=X\r\nC=three\r\n');
  assert.equal(editValue(text, 'C', 'X'), 'A=one\r\nB=two\r\nC=X\r\n');
});

test('applyEdits keeps quotes, export prefix and trailing comments', () => {
  const text = 'A="one"\nexport B=\'two\'\nC=three # note\n';
  assert.equal(editValue(text, 'A', 'X'), 'A="X"\nexport B=\'two\'\nC=three # note\n');
  assert.equal(editValue(text, 'B', 'X'), 'A="one"\nexport B=\'X\'\nC=three # note\n');
  assert.equal(editValue(text, 'C', 'X'), 'A="one"\nexport B=\'two\'\nC=X # note\n');
});

test('applyEdits with an empty quoted value inserts between the quotes', () => {
  assert.equal(editValue('A=""\n', 'A', 'X'), 'A="X"\n');
});

test('applyEdits can replace only the password of a connection URL', () => {
  const text = 'DATABASE_URL=postgres://app:fake-pass@db.example.com/app\n';
  const parsed = d.parseDotenv(text);
  const e = parsed.entries[0];
  const pw = d.connectionPassword(e.value);
  const out = d.applyEdits(parsed, [
    { lineIndex: e.lineIndex, start: e.start + pw.start, end: e.start + pw.end, text: '__ZN_DB__' },
  ]);
  assert.equal(out, 'DATABASE_URL=postgres://app:__ZN_DB__@db.example.com/app\n');
});

test('connectionPassword returns exact offsets with and without a password', () => {
  const withPw = 'mysql://user:fake-pass@db.example.com:3306/app';
  const r = d.connectionPassword(withPw);
  assert.equal(withPw.slice(r.start, r.end), 'fake-pass');
  assert.equal(d.connectionPassword('mysql://user:@db.example.com/app'), null);
  assert.equal(d.connectionPassword('mysql://db.example.com:3306/app'), null);
  const emptyUser = ':fake-pass@db.example.com';
  assert.equal(d.connectionPassword('redis://' + emptyUser) !== null, true);
});

test('connectionPassword finds the password in a quoted .env value', () => {
  const parsed = d.parseDotenv('URL="amqp://u:fake-pass@mq.example.com/v"\r\n');
  const e = parsed.entries[0];
  const r = d.connectionPassword(e.value);
  assert.equal(e.value.slice(r.start, r.end), 'fake-pass');
});
