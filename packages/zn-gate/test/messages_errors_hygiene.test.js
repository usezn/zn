'use strict';
/* Every error code has a message in lib/errors.js and lib/messages.js, and no
 * message shows a stack trace, a Windows drive path or a home folder. */

const test = require('node:test');
const assert = require('node:assert/strict');
const errors = require('../lib/errors');
const messages = require('../lib/messages');

const FORBIDDEN = [
  [/\bstack\b/i, 'a stack'],
  [/^\s+at\s.+(\(|:\d+)/m, 'a stack frame'],
  [/\b[A-Za-z]:[\\/]/, 'a Windows drive path'],
  [/%USERPROFILE%|\$HOME|\bHOMEPATH\b/i, 'a home variable'],
  [/(^|[\s"'(=])~[\\/]/, 'a tilde home folder'],
  [/\/home\/|\/Users\/|\\Users\\/, 'a home folder'],
];

function assertClean(text, label) {
  assert.equal(typeof text, 'string', label + ' is a string');
  assert.ok(text.trim().length > 0, label + ' is not empty');
  for (const [re, what] of FORBIDDEN) {
    assert.ok(!re.test(text), label + ' mentions ' + what + ': ' + text);
  }
}

test('every error code gets a clean message from humanError', () => {
  const codes = Object.values(errors.CODES);
  assert.ok(codes.length > 0);
  for (const code of codes) {
    assert.match(code, /^ZN_[A-Z_]+$/);
    const bare = errors.znError(code);
    assertClean(errors.humanError(bare, {}), code + ' without detail');
    assertClean(errors.humanError(bare, { ZN_VERBOSE: '1' }), code + ' verbose without detail');
    const withDetail = errors.znError(code, 'something went wrong');
    assertClean(errors.humanError(withDetail, {}), code + ' with detail');
    const notRunning = errors.znError(code, 'vault is not running');
    notRunning.vaultNotRunning = true;
    assertClean(errors.humanError(notRunning, {}), code + ' vault not running');
    assertClean(errors.messageWithUnlockHint(withDetail), code + ' with unlock hint');
  }
  assertClean(errors.notImplemented('the thing').message, 'notImplemented');
});

test('every message in messages.js is clean', () => {
  const names = Object.keys(messages);
  assert.ok(names.length > 0);
  const args = [['example'], ['alpha', 'beta'], 'detail', {}];
  for (const name of names) {
    const value = messages[name];
    if (typeof value === 'string') {
      assertClean(value, name);
    } else if (typeof value === 'function' && name !== 'isNetworkFailure' && name !== 'verboseDetail') {
      for (const env of [{}, { ZN_VERBOSE: '1' }]) {
        assertClean(value(...args, env), name);
        assertClean(value(['started from example'], ['x'], 'y', env), name);
      }
    }
  }
});

test('the keychain tables have a clean text for every backend', () => {
  for (const backend of ['macos', 'windows', 'libsecret', 'other']) {
    for (const doing of ['save', 'read']) {
      assertClean(messages.keychainProblem(backend, doing, { detail: 'x', env: { ZN_VERBOSE: '1' } }), backend + ' ' + doing);
    }
  }
});

test('the verbose detail suffix is clean', () => {
  assert.equal(messages.verboseDetail('', { ZN_VERBOSE: '1' }), '');
  assertClean(messages.verboseDetail('exit code 1', { ZN_VERBOSE: '1' }), 'verboseDetail');
});
