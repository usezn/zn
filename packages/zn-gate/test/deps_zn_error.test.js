'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { znError } = require('../lib/deps');

test('znError without extra sets code and message', () => {
  const err = znError('ZN_EXAMPLE', 'something failed');
  assert.ok(err instanceof Error);
  assert.equal(err.code, 'ZN_EXAMPLE');
  assert.equal(err.message, 'something failed');
  assert.equal(typeof err.stack, 'string');
  assert.match(err.stack, /something failed/);
  assert.deepEqual(Object.keys(err).sort(), ['code']);
});

test('znError copies extra fields onto the error', () => {
  const err = znError('ZN_EXAMPLE', 'bad', { detail: 'x', status: 3 });
  assert.equal(err.code, 'ZN_EXAMPLE');
  assert.equal(err.message, 'bad');
  assert.equal(err.detail, 'x');
  assert.equal(err.status, 3);
  assert.ok(err instanceof Error);
  assert.equal(typeof err.stack, 'string');
});

test('znError extra can override the code', () => {
  assert.equal(znError('A', 'm', { code: 'B' }).code, 'B');
});

test('znError turns a non-string message into text', () => {
  assert.equal(znError('C', 42).message, '42');
  assert.equal(znError('C', null).message, 'null');
  assert.equal(znError('C', { a: 1 }).message, '[object Object]');
  assert.equal(znError('C', undefined).message, '');
});
