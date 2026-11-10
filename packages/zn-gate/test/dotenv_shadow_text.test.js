'use strict';

// parseDotenv and isShadowed on small fake .env texts: comments, export,
// quote styles, multi-line values, CRLF, hashes, empty values, odd lines.

const test = require('node:test');
const assert = require('node:assert/strict');
const d = require('../lib/broker/dotenv');

function slices(text) {
  const { entries, lines } = d.parseDotenv(text);
  return entries.map((e) => lines[e.lineIndex].slice(e.start, e.end));
}

test('a comment line holding a secret is ignored by parse and isShadowed', () => {
  const text = '# API_KEY=fake-secret-value-123\n  # TOKEN=fake-token-value-123\n';
  assert.deepEqual(d.parseDotenv(text).entries, []);
  assert.equal(d.isShadowed(text), true);
});

test('export prefix with each quote style gives the inner value range', () => {
  const text = 'export A="dq"\nexport B=\'sq\'\nexport C=`bt`\nexport\tD=plain\n';
  const { entries } = d.parseDotenv(text);
  assert.deepEqual(entries.map((e) => [e.key, e.value, e.quote]), [
    ['A', 'dq', '"'], ['B', 'sq', "'"], ['C', 'bt', '`'], ['D', 'plain', ''],
  ]);
  assert.deepEqual(slices(text), ['dq', 'sq', 'bt', 'plain']);
});

test('isShadowed sees secrets inside every quote style', () => {
  for (const q of ['"', "'", '`']) {
    assert.equal(d.isShadowed(`export API_KEY=${q}fake-secret-value-123${q}`), false, q);
    assert.equal(d.isShadowed(`export API_KEY=${q}__ZN_API_KEY__${q}`), true, q);
  }
});

test('a different quote character inside a quoted value does not close it', () => {
  const { entries } = d.parseDotenv('A="it\'s `ok`"\nB=\'say "hi"\'\n');
  assert.deepEqual(entries.map((e) => e.value), ['it\'s `ok`', 'say "hi"']);
  assert.equal(entries.every((e) => !e.multiline), true);
});

test('a quoted value over several lines is flagged and only its first line is read', () => {
  const text = 'API_KEY="fake-first-line-123\nsecond line\nthird"\nNAME=x\n';
  const { entries } = d.parseDotenv(text);
  assert.deepEqual(entries.map((e) => [e.key, e.value, e.multiline]), [
    ['API_KEY', 'fake-first-line-123', true],
    ['NAME', 'x', false],
  ]);
  assert.equal(d.isShadowed(text), false);
});

test('a multi-line value that starts with a marker counts as shadowed', () => {
  assert.equal(d.isShadowed('API_KEY="__ZN_API_KEY__\nmore"\n'), true);
});

test('CRLF endings stay out of plain, quoted and multi-line values', () => {
  const text = 'A=one\r\nexport B="two"\r\nC=\'three\' # c\r\nD="open\r\nrest"\r\n';
  const parsed = d.parseDotenv(text);
  assert.deepEqual(parsed.entries.map((e) => e.value), ['one', 'two', 'three', 'open']);
  assert.deepEqual(slices(text), ['one', 'two', 'three', 'open']);
  assert.equal(d.applyEdits(parsed, []), text);
});

test('isShadowed works on CRLF text', () => {
  assert.equal(d.isShadowed('API_KEY=__ZN_API_KEY__\r\nNAME=x\r\n'), true);
  assert.equal(d.isShadowed('NAME=x\r\nAPI_KEY=fake-secret-value-123\r\n'), false);
});

test('a hash inside a value: kept in quotes and without a space, cut after a space', () => {
  const { entries } = d.parseDotenv('A="a # b"\nB=a#b\nC=a #b\nD=a\t# b\nE=#x\n');
  assert.deepEqual(entries.map((e) => e.value), ['a # b', 'a#b', 'a', 'a', '#x']);
});

test('a secret before a trailing comment is still detected', () => {
  assert.equal(d.isShadowed('API_KEY=fake-secret-value-123 # rotate me'), false);
  assert.equal(d.isShadowed('API_KEY=__ZN_API_KEY__ # fake-secret-value-123'), true);
});

test('empty values are parsed with an empty range and never block shadowing', () => {
  const text = 'A=\nB=""\nC=\'\'\nAPI_KEY=\nTOKEN=   \n';
  const { entries } = d.parseDotenv(text);
  assert.deepEqual(entries.map((e) => [e.key, e.value]), [['A', ''], ['B', ''], ['C', ''], ['API_KEY', ''], ['TOKEN', '']]);
  for (const e of entries) assert.equal(e.start, e.end);
  assert.equal(d.isShadowed(text), true);
});

test('a line with no equals sign is skipped and does not hide its neighbours', () => {
  const text = 'just some words\nexport ALONE\nAPI_KEY=fake-secret-value-123\n';
  const { entries } = d.parseDotenv(text);
  assert.deepEqual(entries.map((e) => e.key), ['API_KEY']);
  assert.equal(d.isShadowed(text), false);
  assert.equal(d.isShadowed('just some words\nexport ALONE\n'), true);
});
