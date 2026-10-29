'use strict';
/* Checks that keychainHelperFailed and keychainLostKey in lib/messages.js show technical detail
 * (such as a raw exit code) only when ZN_VERBOSE is on, for each backend name. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { keychainHelperFailed, keychainLostKey } = require('../lib/messages');

const BACKENDS = ['macos', 'windows', 'libsecret', 'unknown-backend'];
const QUIET = {};
const VERBOSE = { ZN_VERBOSE: '1' };

test('keychainHelperFailed hides a raw exit code when ZN_VERBOSE is unset', () => {
  const text = keychainHelperFailed('exit code 42', QUIET);
  assert.doesNotMatch(text, /exit code|42|Detail/);
  assert.match(text, /Close this terminal, open a new one and try again/);
});

test('keychainHelperFailed shows the exit code when ZN_VERBOSE is set', () => {
  const text = keychainHelperFailed('exit code 42', VERBOSE);
  assert.match(text, / Detail: exit code 42\.$/);
});

test('keychainHelperFailed adds no detail when there is none, even when verbose', () => {
  assert.doesNotMatch(keychainHelperFailed('', VERBOSE), /Detail/);
  assert.doesNotMatch(keychainHelperFailed(undefined, VERBOSE), /Detail/);
});

test('keychainHelperFailed treats ZN_VERBOSE values other than 1 as off', () => {
  assert.doesNotMatch(keychainHelperFailed('exit code 42', { ZN_VERBOSE: '0' }), /Detail|42/);
});

for (const backend of BACKENDS) {
  test('keychainLostKey for ' + backend + ' has no technical detail when ZN_VERBOSE is unset', () => {
    const text = keychainLostKey(backend, QUIET);
    assert.match(text, /^zn could not save the vault key in /);
    assert.doesNotMatch(text, /Detail|did not return/);
    assert.doesNotMatch(text, /exit code/);
  });

  test('keychainLostKey for ' + backend + ' adds the detail when ZN_VERBOSE is set', () => {
    const quiet = keychainLostKey(backend, QUIET);
    const loud = keychainLostKey(backend, VERBOSE);
    assert.equal(loud, quiet + ' Detail: the keychain did not return the key it was given.');
  });
}

test('keychainLostKey names the right keychain for each backend', () => {
  assert.match(keychainLostKey('macos', QUIET), /in the macOS Keychain\./);
  assert.match(keychainLostKey('windows', QUIET), /in the Windows Credential Manager\./);
  assert.match(keychainLostKey('libsecret', QUIET), /in your Linux keyring \(Secret Service\)\./);
  assert.match(keychainLostKey('unknown-backend', QUIET), /in the system keychain\./);
});
