'use strict';
/* The duration and backend messages name what is accepted, in one plain line. */

const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('../lib/messages');
const { parseDuration } = require('../lib/vault/cli');
const keychain = require('../lib/vault/keychain');

function assertPlain(text) {
  assert.ok(!/\n/.test(text), 'one line');
  assert.ok(!/\b(undefined|null|NaN|Error|stack|exception)\b/i.test(text), 'no programming terms');
  assert.ok(!/\bat .*:\d+/.test(text), 'no stack frame');
}

test('invalidDuration echoes the value and shows accepted examples', () => {
  const text = m.invalidDuration('5x');
  assert.ok(text.includes('"5x"'));
  assert.match(text, /\b\d+m\b/);
  assert.match(text, /\b\d+h\b/);
  assertPlain(text);
});

test('invalidDuration keeps an empty value visible between quotes', () => {
  assert.ok(m.invalidDuration('').includes('""'));
});

test('DURATION_RANGE names both limits and both flags', () => {
  assert.match(m.DURATION_RANGE, /1m/);
  assert.match(m.DURATION_RANGE, /24h/);
  assert.match(m.DURATION_RANGE, /--ttl/);
  assert.match(m.DURATION_RANGE, /--idle/);
  assertPlain(m.DURATION_RANGE);
});

test('parseDuration refuses with these messages', () => {
  assert.throws(() => parseDuration('abc'), (e) => e.message === m.invalidDuration('abc'));
  assert.throws(() => parseDuration('30s'), (e) => e.message === m.DURATION_RANGE);
  assert.throws(() => parseDuration('25h'), (e) => e.message === m.DURATION_RANGE);
});

test('unknownBackend names the bad value and every accepted backend', () => {
  const text = m.unknownBackend('nope', ['keychain', 'passphrase']);
  assert.ok(text.includes('"nope"'));
  assert.ok(text.includes('keychain'));
  assert.ok(text.includes('passphrase'));
  assertPlain(text);
});

test('unknownBackend lists the real backends of the vault', () => {
  const text = m.unknownBackend('nope', keychain.BACKENDS);
  for (const name of keychain.BACKENDS) assert.ok(text.includes(name), name);
  assertPlain(text);
});
