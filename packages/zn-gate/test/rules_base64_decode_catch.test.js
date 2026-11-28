'use strict';

// Only an undecodable Base64 payload is skipped; an error thrown by evaluate() on the decoded text is not
// swallowed (it reaches the caller). Same cases as zn-gate-py/tests/test_base64_decode_catch.py.

const test = require('node:test');
const assert = require('node:assert/strict');
const rules = require('../lib/rules');

const PIPE = 'echo ' + Buffer.from('echo hello world').toString('base64') + ' | base64 -d | sh';

test('an error from evaluate() on the decoded text is not swallowed', () => {
  // The options object throws when the inner evaluate() reads it.
  const options = { get strict() { throw new Error('boom'); } };
  assert.throws(() => rules._checkBase64Pipes([PIPE], options), /boom/);
});

test('invalid Base64 is still ignored', () => {
  const options = { get strict() { throw new Error('must not run'); } };
  assert.deepEqual(rules._checkBase64Pipes(['echo not base64 at all | base64 -d'], options), { block: null, advisory: null });
  assert.equal(rules.evaluate('echo QUJD=REVG | base64 -d').verdict, 'allow');
});
