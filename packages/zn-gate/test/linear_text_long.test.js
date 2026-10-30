'use strict';

// Very long repeated text for each linear-time helper, with a generous time
// limit. The limit is large on purpose so slow machines do not fail it; a
// backtracking regex would take far longer. Behaviour is as it is today.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const lt = require('../lib/linear-text');

const N = 300000;
const LIMIT_MS = 5000;

function timed(fn) {
  const start = process.hrtime.bigint();
  const result = fn();
  const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
  assert.ok(elapsed < LIMIT_MS, `took ${elapsed.toFixed(0)} ms, limit ${LIMIT_MS} ms`);
  return result;
}

test('trimTrailing: long runs of the same character', () => {
  assert.equal(timed(() => lt.trimTrailing(' '.repeat(N), ' ')), '');
  assert.equal(timed(() => lt.trimTrailing('a/'.repeat(N), '/')), 'a/'.repeat(N - 1) + 'a');
});

test('stripInlineComment: long repeated whitespace, newlines and hashes', () => {
  assert.equal(timed(() => lt.stripInlineComment(' '.repeat(N))), ' '.repeat(N));
  assert.equal(timed(() => lt.stripInlineComment('\n'.repeat(N))), '\n'.repeat(N));
  assert.equal(timed(() => lt.stripInlineComment('a #'.repeat(N))), 'a');
  assert.equal(timed(() => lt.stripInlineComment(' #\n'.repeat(N / 3))).length > 0, true);
});

test('lines: long text without and with line breaks', () => {
  assert.deepEqual(timed(() => lt.lines('a'.repeat(N))), ['a'.repeat(N)]);
  assert.equal(timed(() => lt.lines('\r\n'.repeat(N))).length, 2 * N + 1);
});

test('npmAuth: long repeated colons, spaces and keys', () => {
  assert.equal(timed(() => lt.npmAuth(':'.repeat(N))), null);
  assert.equal(timed(() => lt.npmAuth('_auth'.repeat(N / 5))), null);
  assert.equal(timed(() => lt.npmAuth('_authToken' + ' '.repeat(N) + '=')), null);
  assert.equal(timed(() => lt.npmAuth('_authToken=a' + ' '.repeat(N) + 'b')), null);
  assert.deepEqual(timed(() => lt.npmAuth(':'.repeat(N) + '_password=x')), ['_password', 'x']);
});

test('znrulesValue: long repeated spaces and line breaks', () => {
  assert.equal(timed(() => lt.znrulesValue(' '.repeat(N) + 'secret:')), null);
  assert.equal(timed(() => lt.znrulesValue('secret:' + '\n'.repeat(N))), null);
  assert.equal(timed(() => lt.znrulesValue('secret: a' + ' '.repeat(N) + 'b')).length, N + 2);
});
