'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { CODES, znError, notImplemented, humanError, messageWithUnlockHint } = require('../lib/errors');

const quiet = {};
const verbose = { ZN_VERBOSE: '1' };

test('CODES is frozen and has the documented values', () => {
  assert.ok(Object.isFrozen(CODES));
  assert.deepStrictEqual({ ...CODES }, {
    LOCKED: 'ZN_LOCKED',
    POLICY_DENIED: 'ZN_POLICY_DENIED',
    NOT_FOUND: 'ZN_NOT_FOUND',
    NOT_IMPLEMENTED: 'ZN_NOT_IMPLEMENTED',
  });
});

test('znError sets the code and message, and falls back to the code', () => {
  const err = znError(CODES.NOT_FOUND, 'no such item');
  assert.ok(err instanceof Error);
  assert.strictEqual(err.code, 'ZN_NOT_FOUND');
  assert.strictEqual(err.message, 'no such item');
  assert.strictEqual(znError(CODES.LOCKED).message, 'ZN_LOCKED');
});

test('notImplemented names the module and is flagged', () => {
  const err = notImplemented('the broker');
  assert.strictEqual(err.code, CODES.NOT_IMPLEMENTED);
  assert.strictEqual(err.message, 'the broker is not implemented yet');
  assert.strictEqual(err.znNotImplemented, true);
});

test('humanError: locked vault that is not running gives the unlock steps', () => {
  const err = znError(CODES.LOCKED, 'x');
  err.vaultNotRunning = true;
  const text = humanError(err, quiet);
  assert.match(text, /^Your secret vault is locked\. Unlock it in this terminal with: .*unlock\. Then run this command again\.$/);
  assert.ok(!text.includes('ZN_LOCKED'));
});

test('humanError: other locked failures keep their detail', () => {
  assert.strictEqual(humanError(znError(CODES.LOCKED, 'bad keychain'), quiet),
    'zn could not use your secret vault: bad keychain');
  const empty = znError(CODES.LOCKED);
  empty.message = '';
  assert.strictEqual(humanError(empty, quiet), 'zn could not use your secret vault: unknown error');
});

test('humanError: policy denied and not found prefixes and defaults', () => {
  assert.strictEqual(humanError(znError(CODES.POLICY_DENIED, 'host not listed'), quiet), 'Not allowed: host not listed');
  assert.strictEqual(humanError(znError(CODES.NOT_FOUND, 'secret "a"'), quiet), 'Not found: secret "a"');
  const p = znError(CODES.POLICY_DENIED); p.message = '';
  const n = znError(CODES.NOT_FOUND); n.message = '';
  assert.strictEqual(humanError(p, quiet), 'Not allowed: zn blocked this request');
  assert.strictEqual(humanError(n, quiet), 'Not found: the item does not exist');
});

test('humanError: other errors return the plain message', () => {
  assert.strictEqual(humanError(new Error('boom'), quiet), 'boom');
  assert.strictEqual(humanError(notImplemented('x'), quiet), 'x is not implemented yet');
  assert.strictEqual(humanError(null, quiet), '');
  assert.strictEqual(humanError(undefined, quiet), '');
  // A file system error is told in plain words (see fs_error_text.test.js); its own code shows only when verbose.
  const foreign = new Error('disk'); foreign.code = 'ENOENT';
  assert.strictEqual(humanError(foreign, quiet), 'a file does not exist, or a folder on its path is missing.');
  assert.strictEqual(humanError(foreign, verbose), '[ENOENT] a file does not exist, or a folder on its path is missing.');
});

test('humanError: the code is shown only when verbose', () => {
  const err = znError(CODES.POLICY_DENIED, 'no');
  assert.strictEqual(humanError(err, verbose), '[ZN_POLICY_DENIED] Not allowed: no');
  assert.strictEqual(humanError(err, { DEBUG: 'zn:*' }), '[ZN_POLICY_DENIED] Not allowed: no');
  assert.strictEqual(humanError(err, { DEBUG: '*' }), 'Not allowed: no');
});

test('messageWithUnlockHint adds the hint once for a locked error', () => {
  const out = messageWithUnlockHint(znError(CODES.LOCKED, 'vault is closed.  '));
  assert.match(out, /^vault is closed; run `.*unlock`$/);
});

test('messageWithUnlockHint leaves messages that already say the next step', () => {
  assert.strictEqual(messageWithUnlockHint(znError(CODES.LOCKED, 'Run zn unlock first')), 'Run zn unlock first');
  assert.strictEqual(messageWithUnlockHint(znError(CODES.LOCKED, 'damaged; use vault reset')), 'damaged; use vault reset');
});

test('messageWithUnlockHint leaves non-locked errors and plain values alone', () => {
  assert.strictEqual(messageWithUnlockHint(znError(CODES.NOT_FOUND, 'gone')), 'gone');
  assert.strictEqual(messageWithUnlockHint(new Error('plain')), 'plain');
  assert.strictEqual(messageWithUnlockHint('text'), 'text');
});
