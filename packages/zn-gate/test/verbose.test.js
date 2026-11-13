'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { isVerbose } = require('../lib/verbose');
const { humanError, znError, CODES } = require('../lib/errors');

test('ZN_VERBOSE=1 turns the detail on', () => {
  assert.strictEqual(isVerbose({ ZN_VERBOSE: '1' }), true);
  assert.strictEqual(isVerbose({ ZN_VERBOSE: '0' }), false);
});

test('DEBUG entries that name zn turn the detail on', () => {
  for (const v of ['zn', 'zn*', 'zn:*', 'zn-gate', 'zn-gate*', 'zn-gate:*', 'express:*,zn', 'a zn:x', 'a, zn']) {
    assert.strictEqual(isVerbose({ DEBUG: v }), true, v);
  }
});

test('DEBUG set by other tools does not turn the detail on', () => {
  for (const v of ['*', 'express:*', '1', 'true', 'znx', 'myzn', 'zn_other', '', 'a:zn']) {
    assert.strictEqual(isVerbose({ DEBUG: v }), false, v);
  }
  assert.strictEqual(isVerbose({}), false);
});

test('ZN_VERBOSE: answer for each value', () => {
  const table = [
    [undefined, false],
    ['', false],
    ['1', true],
    ['0', false],
    ['true', false],
    ['false', false],
    [' ', false],
    [' 1', false],
    ['1 ', false],
  ];
  for (const [value, expected] of table) {
    const env = value === undefined ? {} : { ZN_VERBOSE: value };
    assert.strictEqual(isVerbose(env), expected, JSON.stringify(value));
  }
});

test('DEBUG made only of spaces or separators is off, and padded entries still match', () => {
  for (const v of ['   ', ',', ' , ']) assert.strictEqual(isVerbose({ DEBUG: v }), false, JSON.stringify(v));
  for (const v of [' zn ', '  zn-gate:x,']) assert.strictEqual(isVerbose({ DEBUG: v }), true, JSON.stringify(v));
});

test('ZN_VERBOSE=1 wins over an unrelated DEBUG, and a non-string DEBUG is ignored', () => {
  assert.strictEqual(isVerbose({ ZN_VERBOSE: '1', DEBUG: 'express:*' }), true);
  assert.strictEqual(isVerbose({ ZN_VERBOSE: '0', DEBUG: 'zn' }), true);
  assert.strictEqual(isVerbose({ DEBUG: 1 }), false);
});

test('the error code is shown only for a zn-specific switch', () => {
  const err = znError(CODES.NOT_FOUND, 'gone');
  assert.ok(!humanError(err, { DEBUG: '*' }).includes('['));
  assert.ok(humanError(err, { DEBUG: 'zn' }).includes('[' + err.code + ']'));
});
