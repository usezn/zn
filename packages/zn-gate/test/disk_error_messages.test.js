'use strict';
process.env.ZN_STATS = 'off';

// A full disk or a full quota reaches a person in plain words. Node reports a quota error on Linux as code 'UNKNOWN'
// with errno -122, so it is recognised by its errno. The vault daemon passes the same sentences on for disk and
// permission errors and keeps everything else hidden. Errors are simulated: no real disk is filled.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const { fsErrorText, humanError } = require('../lib/errors');
const { vaultFsMessage } = require('../lib/vault/daemon');

const EDQUOT = os.constants.errno.EDQUOT;
const quota = (p) => Object.assign(new Error("UNKNOWN: unknown error, write '" + p + "'"), { code: 'UNKNOWN', errno: -EDQUOT, path: p });
const RAW = /\b(?:UNKNOWN|EACCES|EPERM|ENOENT|ENOSPC|EDQUOT|EROFS)\b|errno|unknown error/;

test('on Linux, an UNKNOWN error with errno -122 is a full quota, in the plain sentence', { skip: typeof EDQUOT !== 'number' }, () => {
  const text = fsErrorText(quota('/home/example-user/.claude/settings.json'), null, {}, 'linux');
  assert.equal(text, 'Your disk quota is used up, so /home/example-user/.claude/settings.json cannot be written. Free some space, then try again.');
  assert.doesNotMatch(text, RAW);
  // The same error from a copy names the path it was copied to, and the temporary file is shown as its real name.
  const copy = fsErrorText(Object.assign(new Error('x'), { code: 'UNKNOWN', errno: -EDQUOT }), '/home/example-user/.claude/settings.json.bak-zn-1', {}, 'linux');
  assert.match(copy, /^Your disk quota is used up, so \/home\/example-user\/\.claude\/settings\.json\.bak-zn-1 cannot be written/);
  // With ZN_VERBOSE the code is shown, as for every other file system error.
  assert.match(fsErrorText(quota('/x/y'), null, { ZN_VERBOSE: '1' }, 'linux'), /^\[EDQUOT\] Your disk quota is used up, so \/x\/y/);
});

test('humanError on Linux uses the quota sentence instead of the raw Node message', { skip: typeof EDQUOT !== 'number' || process.platform !== 'linux' }, () => {
  const text = humanError(quota('/x/.zn/config.json'), {});
  assert.match(text, /^Your disk quota is used up, so \/x\/\.zn\/config\.json cannot be written/);
  assert.doesNotMatch(text, RAW);
});

test('the quota mapping is for Linux only; other platforms and other UNKNOWN errnos are left alone', { skip: typeof EDQUOT !== 'number' }, () => {
  for (const platform of ['darwin', 'win32']) {
    assert.equal(fsErrorText(quota('/x/y'), null, {}, platform), null, platform);
  }
  const other = Object.assign(new Error('unknown'), { code: 'UNKNOWN', errno: -5, path: '/x/y' });
  assert.equal(fsErrorText(other, null, {}, 'linux'), null);
  assert.equal(fsErrorText(new Error('plain'), null, {}, 'linux'), null);
});

test('a full disk (ENOSPC) keeps its sentence on every platform', () => {
  const e = Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
  assert.equal(fsErrorText(e, 'the vault', {}, 'linux'), 'The disk that holds the vault is full. Free some space, then try again.');
  assert.equal(fsErrorText(e, 'the vault', {}, 'win32'), 'The disk that holds the vault is full. Free some space, then try again.');
});

test('vault: a full disk or a full quota is said in plain words, naming only "the vault"', { skip: typeof EDQUOT !== 'number' || process.platform !== 'linux' }, () => {
  const full = Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC', path: '/home/example-user/.zn/vault/.secrets.age.123.abc.zn-tmp' });
  assert.equal(vaultFsMessage(full), 'The disk that holds the vault is full. Free some space, then try again.');
  assert.equal(vaultFsMessage(quota('/home/example-user/.zn/vault/secrets.age')), 'Your disk quota is used up, so the vault cannot be written. Free some space, then try again.');
  const denied = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
  assert.equal(vaultFsMessage(denied), 'Your account is not allowed to read or change the vault. Check who owns it and its permissions, then try again.');
});

test('vault: any other error keeps the hidden text, and no path, value or internal detail is shown', () => {
  assert.equal(vaultFsMessage(new Error('fake-secret-value-0001-abcdefgh leaked in a message')), null);
  assert.equal(vaultFsMessage(Object.assign(new Error('TypeError: x'), { code: 'ERR_INVALID_ARG_TYPE' })), null);
  assert.equal(vaultFsMessage(null), null);
  assert.equal(vaultFsMessage('plain string'), null);
  const enospc = Object.assign(new Error('boom fake-secret-value-0001-abcdefgh'), { code: 'ENOSPC', path: '/home/example-user/.zn/vault/x' });
  const text = vaultFsMessage(enospc);
  assert.doesNotMatch(text, /fake-secret|example-user|\/home\//);
});
