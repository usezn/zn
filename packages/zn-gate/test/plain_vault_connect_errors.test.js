'use strict';
/* Vault, keychain and connect errors are plain sentences with a next step; the raw code shows only with ZN_VERBOSE=1. */

const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('../lib/messages');
const cloudKey = require('../lib/cloud-key');
const connectCli = require('../lib/connect-cli');
const { humanError, CODES, znError } = require('../lib/errors');

const VERBOSE = { ZN_VERBOSE: '1' };

test('keychain: one sentence and the next step for each platform, no raw code', () => {
  const mac = m.keychainRefused('macos', 36, {});
  assert.match(mac, /^zn could not save its key in the macOS keychain\. Next step: open Keychain Access, allow zn/);
  assert.ok(!/36|exit/.test(mac));
  const win = m.keychainReadFailed('windows', 1, {});
  assert.match(win, /Windows Credential Manager/);
  assert.match(win, /zn unlock --backend passphrase/);
  const linux = m.keychainReadFailed('linux', 5, {});
  assert.match(linux, /libsecret-tools/);
  assert.match(linux, /zn unlock --backend passphrase/);
  assert.match(m.SECRET_TOOL_MISSING, /libsecret-tools/);
  assert.match(m.keychainHelperFailedToStart('/usr/bin/security', 'ENOENT', {}), /Keychain Access/);
  assert.ok(!/ENOENT/.test(m.keychainHelperFailedToStart('secret-tool', 'ENOENT', {})));
});

test('keychain: the raw code appears only with ZN_VERBOSE=1', () => {
  assert.match(m.keychainRefused('macos', 36, VERBOSE), /\[macos exit 36\]$/);
  assert.match(m.keychainHelperFailedToStart('secret-tool', 'ENOENT', VERBOSE), /ENOENT/);
  assert.equal(m.rawCode('x', {}), '');
});

test('a plain vault error is printed as it is, without the "could not use your secret vault" prefix', () => {
  const e = Object.assign(znError(CODES.LOCKED, m.keychainRefused('linux', 1, {})), { plain: true });
  assert.equal(humanError(e, {}), m.keychainRefused('linux', 1, {}));
});

test('daemon: start failures say to lock and unlock', () => {
  for (const text of [m.daemonStartTimeout({}), m.daemonExitedAtStart(1, {}), m.DAEMON_START_FAILED]) {
    assert.match(text, /run `zn lock`, then `zn unlock`\.$/);
  }
  assert.ok(!/\(1\)|timeout/.test(m.daemonExitedAtStart(1, {}) + m.daemonStartTimeout({})));
  assert.match(m.daemonExitedAtStart(1, VERBOSE), /\[exit 1\]/);
});

test('client: a slow or stuck vault is not reported as "locked"', () => {
  const text = m.vaultNotAnswering('timeout', {});
  assert.match(text, /^the vault did not answer\. It may be busy, or an old session may be stuck\./);
  assert.match(text, /zn lock`, then `zn unlock/);
  assert.ok(!/timeout|ENOENT/.test(text));
});

test('audit log failure: says not to delete it and links the docs', () => {
  const text = m.auditVerifyFailed(7, 'bad mac', {});
  assert.match(text, /Do not delete it/);
  assert.ok(text.includes('https://usezn.com/docs/troubleshooting'));
  assert.ok(!/bad mac/.test(text));
  assert.match(m.auditVerifyFailed(7, 'bad mac', VERBOSE), /\[bad mac\]$/);
});

test('connect: network error asks to check the connection and run connect again', () => {
  const text = m.connectUnverified('network', 'ENOTFOUND', null, {});
  assert.equal(text, 'Could not reach usezn.com (check your internet connection, then run `zn-gate connect` again). Nothing was saved.');
  assert.match(m.connectUnverified('network', 'ENOTFOUND', null, VERBOSE), /\[ENOTFOUND\]$/);
  assert.ok(!/HTTP 502/.test(m.connectUnverified('http', 'HTTP 502', null, {})));
});

test('connect: an environment refusal names the variable and does not mention a saved key', async () => {
  const saved = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = '--require ./x.js';
  try {
    const calls = [];
    const r = await connectCli.verifyKey({ request() { calls.push(1); throw new Error('must not be called'); } }, 'zn_' + 'a'.repeat(48));
    assert.equal(calls.length, 0);
    assert.equal(r.state, 'failed');
    assert.equal(r.kind, 'refusal');
    assert.equal(r.envVar, 'NODE_OPTIONS');
    const text = m.connectUnverified(r.kind, r.detail, r.envVar, {});
    assert.match(text, /while NODE_OPTIONS is set/);
    assert.match(text, /Unset NODE_OPTIONS in this terminal and try again\./);
    assert.ok(!/saved key/.test(text));
  } finally {
    if (saved === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = saved;
  }
});

test('connect: tlsRefusalVar names the variable behind tlsRefusal', () => {
  assert.equal(cloudKey.tlsRefusalVar({}), null);
  assert.equal(cloudKey.tlsRefusalVar({ NODE_TLS_REJECT_UNAUTHORIZED: '0' }), 'NODE_TLS_REJECT_UNAUTHORIZED');
  assert.equal(cloudKey.tlsRefusalVar({ SSL_CERT_FILE: 'x' }), 'SSL_CERT_FILE');
  assert.ok(cloudKey.tlsRefusal({ NODE_DEBUG: 'http' }));
});

test('connect: no secure store text goes with how to set the key per shell', () => {
  const text = m.connectNoStore();
  assert.match(text, /macOS or Linux: +export ZN_API_KEY=<your key> ZN_CLOUD=1/);
  assert.match(text, /Windows PowerShell: +\$env:ZN_API_KEY/);
  assert.match(text, /`zn unlock`/);
});
