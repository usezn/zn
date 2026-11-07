'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { isNetworkFailure, verboseDetail } = require('../lib/messages');

test('isNetworkFailure: an HTTP status is not a network failure', () => {
  assert.strictEqual(isNetworkFailure('HTTP 503'), false);
});

test('isNetworkFailure: a sentence with "is set" is not a network failure', () => {
  assert.strictEqual(isNetworkFailure('SOME_VARIABLE is set, so this was refused'), false);
});

test('isNetworkFailure: a Node error code is a network failure', () => {
  assert.strictEqual(isNetworkFailure('ENOTFOUND'), true);
});

test('isNetworkFailure: empty, undefined and null count as network failures', () => {
  assert.strictEqual(isNetworkFailure(''), true);
  assert.strictEqual(isNetworkFailure(undefined), true);
  assert.strictEqual(isNetworkFailure(null), true);
});

test('verboseDetail: in verbose mode it starts with Detail and cuts at 120 characters', () => {
  const out = verboseDetail('x'.repeat(200), { ZN_VERBOSE: '1' });
  assert.strictEqual(out.trim(), 'Detail: ' + 'x'.repeat(120) + '.');
  assert.ok(out.trimStart().startsWith('Detail'));
});

test('verboseDetail: without verbose mode it returns an empty string', () => {
  assert.strictEqual(verboseDetail('some detail', {}), '');
});

test('verboseDetail: an empty detail returns an empty string even in verbose mode', () => {
  assert.strictEqual(verboseDetail('', { ZN_VERBOSE: '1' }), '');
});

const networkFailureTable = [
  ['ECONNREFUSED', 'ECONNREFUSED', true],
  ['ENOTFOUND', 'ENOTFOUND', true],
  ['ETIMEDOUT', 'ETIMEDOUT', true],
  ['ECONNRESET', 'ECONNRESET', true],
  ['a TLS code', 'CERT_HAS_EXPIRED', true],
  ['a plain Error object', new Error('something broke'), true],
  ['a plain string', 'timed out', true],
];

for (const [name, input, expected] of networkFailureTable) {
  test('isNetworkFailure table: ' + name + ' gives ' + expected, () => {
    assert.strictEqual(isNetworkFailure(input), expected);
  });
}
