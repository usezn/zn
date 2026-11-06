'use strict';

// Edge cases of the linear-time text helpers: empty input, short and long text,
// and non-ASCII characters. These describe the behaviour as it is today.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const lt = require('../lib/linear-text');

test('trimTrailing: empty, short, long and non-ASCII input', () => {
  assert.equal(lt.trimTrailing('', ' /'), '');
  assert.equal(lt.trimTrailing('abc', ''), 'abc');
  assert.equal(lt.trimTrailing('abc///', '/'), 'abc');
  assert.equal(lt.trimTrailing('///', '/'), '');
  assert.equal(lt.trimTrailing('a/b', '/'), 'a/b');
  assert.equal(lt.trimTrailing('café ', ' '), 'café');
  assert.equal(lt.trimTrailing('x' + '*'.repeat(200000), '*'), 'x');
});

test('stripInlineComment: empty, short, long and non-ASCII input', () => {
  assert.equal(lt.stripInlineComment(''), '');
  assert.equal(lt.stripInlineComment('value'), 'value');
  assert.equal(lt.stripInlineComment('value # note'), 'value');
  assert.equal(lt.stripInlineComment('value#note'), 'value#note');
  assert.equal(lt.stripInlineComment('value   \t# note'), 'value');
  assert.equal(lt.stripInlineComment('café # über'), 'café');
  assert.equal(lt.stripInlineComment('a' + ' '.repeat(100000)), 'a' + ' '.repeat(100000));
  assert.equal(lt.stripInlineComment('a' + ' '.repeat(100000) + '#c'), 'a');
});

test('lines: splits at every line break character', () => {
  assert.deepEqual(lt.lines(''), ['']);
  assert.deepEqual(lt.lines('abc'), ['abc']);
  assert.deepEqual(lt.lines('a\nb\r\nc'), ['a', 'b', '', 'c']);
  assert.deepEqual(lt.lines('a b c'), ['a', 'b', 'c']);
  assert.deepEqual(lt.lines('é\nü'), ['é', 'ü']);
  assert.equal(lt.lines('x\n'.repeat(50000)).length, 50001);
});

test('npmAuth: empty, matching, non-matching and non-ASCII lines', () => {
  assert.equal(lt.npmAuth(''), null);
  assert.equal(lt.npmAuth('registry=https://registry.example.com/'), null);
  assert.deepEqual(lt.npmAuth('_authToken=fake-token'), ['_authToken', 'fake-token']);
  assert.deepEqual(lt.npmAuth('//registry.example.com/:_authToken = fake'), ['_authToken', 'fake']);
  assert.deepEqual(lt.npmAuth('_auth=abc'), ['_auth', 'abc']);
  assert.deepEqual(lt.npmAuth('_password=abc'), ['_password', 'abc']);
  assert.equal(lt.npmAuth('_authToken='), null);
  assert.equal(lt.npmAuth('_authToken=two words'), null);
  assert.equal(lt.npmAuth('x_authToken=abc'), null);
  assert.deepEqual(lt.npmAuth('_authToken=töken'), ['_authToken', 'töken']);
  assert.equal(lt.npmAuth('_authToken=' + ' '.repeat(100000)), null);
  assert.deepEqual(lt.npmAuth('_authToken=' + 'a'.repeat(100000))[1].length, 100000);
});

test('znrulesValue: empty, short, long and non-ASCII lines', () => {
  assert.equal(lt.znrulesValue(''), null);
  assert.equal(lt.znrulesValue('other: x'), null);
  assert.equal(lt.znrulesValue('secret: abc'), 'abc');
  assert.equal(lt.znrulesValue('  secret:   abc def  '), 'abc def');
  assert.equal(lt.znrulesValue('secret: café'), 'café');
  assert.equal(lt.znrulesValue('secret:'), null);
  assert.equal(lt.znrulesValue('secret:   '), ' ');
  assert.equal(lt.znrulesValue('secret: a\nb'), null);
  assert.equal(lt.znrulesValue('secret:' + ' '.repeat(100000)), ' ');
  assert.equal(lt.znrulesValue('secret: ' + 'a'.repeat(100000)).length, 100000);
});

test('LINE_BREAKS holds the four line break characters', () => {
  assert.deepEqual([...lt.LINE_BREAKS].sort(), ['\n', '\r', '\u2028', '\u2029']);
});
