'use strict';
/* Extra cases for connectUnverified and keychainProblem in lib/messages.js:
 * every kind of detail with ZN_VERBOSE on and off, every backend, both actions,
 * the connect-key slot and an unknown backend. Pins today's behaviour. */

const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('../lib/messages');

const OFF = {};
const ON = { ZN_VERBOSE: '1' };
const NETWORK = /^Could not reach usezn\.com, so the key was not checked and nothing was saved\. Check your internet connection, then run `zn-gate connect` again\./;
const SERVER = /^usezn\.com is not answering properly right now, so the key was not checked and nothing was saved\. Try `zn-gate connect` again in a few minutes\./;

test('connectUnverified: empty detail reads as a network failure and never shows a detail', () => {
  for (const empty of ['', undefined, null]) {
    for (const env of [OFF, ON]) {
      const text = m.connectUnverified(empty, env);
      assert.match(text, NETWORK);
      assert.doesNotMatch(text, /Detail:/);
    }
  }
});

test('connectUnverified: network failure text shows the detail only with ZN_VERBOSE', () => {
  const off = m.connectUnverified('ETIMEDOUT', OFF);
  assert.match(off, NETWORK);
  assert.ok(off.endsWith('again.'));
  assert.doesNotMatch(off, /ETIMEDOUT/);
  const on = m.connectUnverified('ETIMEDOUT', ON);
  assert.match(on, NETWORK);
  assert.ok(on.endsWith(' Detail: ETIMEDOUT.'));
});

test('connectUnverified: HTTP 502 and HTTP 429 get the server wording', () => {
  for (const code of ['HTTP 502', 'HTTP 429']) {
    const off = m.connectUnverified(code, OFF);
    assert.match(off, SERVER);
    assert.doesNotMatch(off, /Detail:|50[0-9]|429/);
    const on = m.connectUnverified(code, ON);
    assert.match(on, SERVER);
    assert.ok(on.endsWith(' Detail: ' + code + '.'));
  }
});

test('connectUnverified: any other text is treated as a network failure', () => {
  for (const other of ['something odd happened', 'HTTP abc', 'HTTP 502 extra', 'certificate has expired']) {
    assert.match(m.connectUnverified(other, OFF), NETWORK);
    assert.doesNotMatch(m.connectUnverified(other, OFF), /Detail:/);
    assert.ok(m.connectUnverified(other, ON).endsWith(' Detail: ' + other + '.'));
  }
});

test('connectUnverified: a long detail is cut to 120 characters when shown', () => {
  const long = 'E'.repeat(300);
  assert.ok(m.connectUnverified(long, ON).endsWith(' Detail: ' + 'E'.repeat(120) + '.'));
});

test('connectUnverified: a sentence about this computer is returned as is', () => {
  const sentence = 'HTTPS_PROXY is set in this terminal.';
  for (const env of [OFF, ON]) {
    assert.equal(m.connectUnverified(sentence, env), sentence + ' Nothing was saved.');
  }
});

const HELP = {
  macos: [/the macOS Keychain\. /, /choose Allow/],
  windows: [/the Windows Credential Manager\. /, /Credential Manager works/],
  libsecret: [/your Linux keyring \(Secret Service\)\. /, /keyring is unlocked/],
};

test('keychainProblem: each backend, save and read, for the vault key', () => {
  for (const backend of Object.keys(HELP)) {
    for (const doing of ['save', 'read']) {
      const text = m.keychainProblem(backend, doing, { env: OFF });
      assert.ok(text.startsWith('zn could not ' + doing + ' the vault key in '));
      for (const re of HELP[backend]) assert.match(text, re);
      if (doing === 'save') assert.match(text, /Or create the vault with a passphrase instead: `.*unlock --backend passphrase`\.$/);
      else assert.doesNotMatch(text, /passphrase/);
      assert.doesNotMatch(text, /Detail:/);
    }
  }
});

test('keychainProblem: the connect key never offers a passphrase', () => {
  for (const backend of Object.keys(HELP)) {
    for (const doing of ['save', 'read']) {
      const text = m.keychainProblem(backend, doing, { slotIsVault: false, env: OFF });
      assert.ok(text.startsWith('zn could not ' + doing + ' the zn-gate connect key in '));
      for (const re of HELP[backend]) assert.match(text, re);
      assert.doesNotMatch(text, /passphrase/);
    }
  }
});

test('keychainProblem: detail follows ZN_VERBOSE', () => {
  for (const backend of Object.keys(HELP)) {
    const off = m.keychainProblem(backend, 'read', { detail: 'exit 7', env: OFF });
    assert.doesNotMatch(off, /exit 7/);
    const on = m.keychainProblem(backend, 'read', { detail: 'exit 7', env: ON });
    assert.ok(on.endsWith(' Detail: exit 7.'));
  }
});

test('keychainProblem: an unknown backend uses the generic place and no help', () => {
  const save = m.keychainProblem('nonesuch', 'save', { env: OFF });
  assert.ok(save.startsWith('zn could not save the vault key in the system keychain. '));
  assert.doesNotMatch(save, /Allow|Credential Manager|keyring/);
  assert.match(save, /Or create the vault with a passphrase instead/);
  const read = m.keychainProblem('nonesuch', 'read', { slotIsVault: false, env: OFF });
  assert.equal(read, 'zn could not read the zn-gate connect key in the system keychain. ');
  assert.ok(m.keychainProblem(undefined, 'read', { env: OFF }).includes('in the system keychain.'));
});
