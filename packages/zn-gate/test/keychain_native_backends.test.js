'use strict';

// The OS keychain helpers (lib/vault/keychain.js), with the Windows helper replaced by a small shell script that
// answers the way the real one does (exit 3 when an item is missing). No real keychain is touched: the vault
// identity is a fake string and the test keychain is never opened.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempDir } = require('./helpers/tmp');
const exe = require('../lib/exe');
const keychain = require('../lib/vault/keychain');
const { CODES } = require('../lib/errors');

const POSIX = { skip: process.platform === 'win32' && 'the fake PowerShell is a #!/bin/sh script' };
const FAKE_IDENTITY = 'AGE-SECRET-KEY-1FAKEONLYFORTESTSNOTAREALKEYNOTAREALKEYNOTAREALKEYNOT';
const windows = keychain._native.windows;

// Answers like the Windows helper: store prints ok, read prints the item (exit 3 when missing), delete prints ok.
// FAKE_CRED selects a failure: "fail" exits 4 or 5, "missing" exits 3.
function fakePowerShell(t) {
  const dir = tempDir(t, 'zn-kc-ps-');
  const file = path.join(dir, 'powershell');
  fs.writeFileSync(file, [
    '#!/bin/sh',
    'cat > /dev/null',
    'case "$ZN_CRED_OP" in',
    '  write) if [ "$FAKE_CRED" = fail ]; then echo denied >&2; exit 5; fi; printf ok ;;',
    '  read) if [ "$FAKE_CRED" = missing ]; then exit 3; fi; if [ "$FAKE_CRED" = fail ]; then exit 4; fi; echo "' + FAKE_IDENTITY + '" ;;',
    '  delete) if [ "$FAKE_CRED" = missing ]; then exit 3; fi; printf ok ;;',
    'esac',
    '',
  ].join('\n'), { mode: 0o755 });
  t.mock.method(exe, 'systemPowerShell', () => file);
  return file;
}

function withCred(t, mode) {
  const old = process.env.FAKE_CRED;
  if (mode === undefined) delete process.env.FAKE_CRED; else process.env.FAKE_CRED = mode;
  t.after(() => { if (old === undefined) delete process.env.FAKE_CRED; else process.env.FAKE_CRED = old; });
}

test('windows keychain: a stored identity is confirmed by the helper', POSIX, (t) => {
  fakePowerShell(t);
  withCred(t, undefined);
  assert.doesNotThrow(() => windows.store(FAKE_IDENTITY));
});

test('windows keychain: a helper that refuses the write is reported as a locked keychain', POSIX, (t) => {
  fakePowerShell(t);
  withCred(t, 'fail');
  assert.throws(() => windows.store(FAKE_IDENTITY), (err) => err.code === CODES.LOCKED);
});

test('windows keychain: a stored identity is read back without its line ending', POSIX, (t) => {
  fakePowerShell(t);
  withCred(t, undefined);
  assert.equal(windows.load(), FAKE_IDENTITY);
});

test('windows keychain: an item that is not there reads as null, and a failing read throws', POSIX, (t) => {
  fakePowerShell(t);
  withCred(t, 'missing');
  assert.equal(windows.load(), null);
  withCred(t, 'fail');
  assert.throws(() => windows.load(), (err) => err.code === CODES.LOCKED);
});

test('windows keychain: removing reports whether the helper deleted the item', POSIX, (t) => {
  fakePowerShell(t);
  withCred(t, undefined);
  assert.equal(windows.remove(), true);
  withCred(t, 'missing');
  assert.equal(windows.remove(), false);
});

test('windows keychain: without a system PowerShell nothing is run and the vault refuses', (t) => {
  t.mock.method(exe, 'systemPowerShell', () => null);
  assert.throws(() => windows.load(), (err) => err.code === CODES.LOCKED);
  assert.throws(() => windows.store(FAKE_IDENTITY), (err) => err.code === CODES.LOCKED);
});

const SECRET_TOOL_DIRS = ['/usr/bin', '/bin', '/usr/local/bin', '/run/current-system/sw/bin'];
const secretToolInstalled = SECRET_TOOL_DIRS.some((d) => fs.existsSync(path.join(d, 'secret-tool')));

test('libsecret keychain: without secret-tool installed, every operation refuses with a locked keychain', { skip: secretToolInstalled && 'secret-tool is installed here' }, () => {
  const native = keychain._native.libsecret;
  assert.throws(() => native.store(FAKE_IDENTITY), (err) => err.code === CODES.LOCKED);
  assert.throws(() => native.load(), (err) => err.code === CODES.LOCKED);
  assert.throws(() => native.remove(), (err) => err.code === CODES.LOCKED);
});
