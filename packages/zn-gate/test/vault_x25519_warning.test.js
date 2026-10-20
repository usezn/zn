'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../lib/vault/store');

test('the X25519 ExperimentalWarning is recognised in every call shape', () => {
  const msg = 'The X25519 Web Crypto API algorithm is an experimental feature and might change at any time';
  assert.equal(store.isX25519Warning(msg, 'ExperimentalWarning'), true);
  assert.equal(store.isX25519Warning(msg, { type: 'ExperimentalWarning' }), true);
  const err = new Error(msg); err.name = 'ExperimentalWarning';
  assert.equal(store.isX25519Warning(err, undefined), true);
});

test('other warnings are not recognised', () => {
  assert.equal(store.isX25519Warning('Another experimental feature', 'ExperimentalWarning'), false);
  assert.equal(store.isX25519Warning('X25519 is deprecated', 'DeprecationWarning'), false);
});

test('silenceX25519Warning drops only the X25519 warning', () => {
  const original = process.emitWarning;
  const seen = [];
  process.emitWarning = (w, t) => { seen.push(String(w)); };
  try {
    store.silenceX25519Warning();
    process.emitWarning('The X25519 Web Crypto API algorithm is an experimental feature', 'ExperimentalWarning');
    process.emitWarning('Something else is experimental', 'ExperimentalWarning');
    process.emitWarning('legacy thing', 'DeprecationWarning', 'DEP0001');
  } finally {
    process.emitWarning = original;
  }
  assert.deepEqual(seen, ['Something else is experimental', 'legacy thing']);
});
