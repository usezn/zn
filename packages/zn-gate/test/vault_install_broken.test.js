'use strict';

// A broken install (the bundled age library missing or failing to load) must say so and never
// point at `vault reset`; a wrong passphrase and a really damaged identity.age keep their messages.
// Temporary ZN_HOME, fake passphrases, the age loader stubbed (nothing is uninstalled).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const childProcess = require('child_process');
const realSpawnSync = childProcess.spawnSync;
childProcess.spawnSync = () => ({ error: Object.assign(new Error('blocked in tests'), { code: 'EBLOCKED' }) });
const keychain = require('../lib/vault/keychain');
const store = require('../lib/vault/store');
childProcess.spawnSync = realSpawnSync;
const reset = require('../lib/vault/reset');
const { messageWithUnlockHint } = require('../lib/errors');

const PASS = 'correct horse battery staple';

async function vaultHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-broken-install-'));
  process.env.ZN_HOME = dir;
  process.env.ZN_VAULT_BACKEND = 'passphrase';
  await keychain.initIdentity({ backend: 'passphrase', passphrase: PASS, workFactor: 1, home: dir });
  return dir;
}
function cleanup(dir) {
  store._useAgeLoader();
  delete process.env.ZN_HOME;
  delete process.env.ZN_VAULT_BACKEND;
  fs.rmSync(dir, { recursive: true, force: true });
}
async function failure(opts) {
  try { await keychain.loadIdentity(opts); } catch (err) { return err; }
  assert.fail('loadIdentity should have failed');
}

test('the age library missing: install message, no reset hint, no wrong-passphrase count', async () => {
  const dir = await vaultHome();
  try {
    store._useAgeLoader(() => Promise.reject(Object.assign(new Error("Cannot find package 'age-encryption' imported from x"), { code: 'ERR_MODULE_NOT_FOUND' })));
    const err = await failure({ backend: 'passphrase', passphrase: PASS, home: dir });
    const text = messageWithUnlockHint(err);
    assert.match(text, /installation is incomplete/);
    assert.match(text, /npm install -g zn-gate/);
    assert.ok(!/run `[^`]*vault reset/.test(text), text);
    assert.ok(!/looks damaged/.test(text), text);
    assert.notEqual(err.code, 'ZN_LOCKED');
    assert.notEqual(err.reason, keychain.WRONG_PASSPHRASE);
    assert.equal(reset.hintForUnlockError(err, { home: dir }), null);
  } finally { cleanup(dir); }
});

test('the age library failing while loading is the same install error', async () => {
  const dir = await vaultHome();
  try {
    store._useAgeLoader(() => Promise.reject(new SyntaxError('Unexpected token')) );
    const err = await failure({ backend: 'passphrase', passphrase: PASS, home: dir });
    assert.equal(err.znInstall, true);
    assert.match(err.message, /installation is incomplete/);
    store._useAgeLoader(() => Promise.resolve({ Decrypter: class { addPassphrase() {} decrypt() { throw new TypeError('d.decrypt is not a function'); } } }));
    const err2 = await failure({ backend: 'passphrase', passphrase: PASS, home: dir });
    assert.match(err2.message, /installation is incomplete/);
  } finally { cleanup(dir); }
});

test('the vault opens again once the library loads (the vault was never damaged)', async () => {
  const dir = await vaultHome();
  try {
    store._useAgeLoader(() => Promise.reject(Object.assign(new Error('Cannot find module'), { code: 'MODULE_NOT_FOUND' })));
    await failure({ backend: 'passphrase', passphrase: PASS, home: dir });
    store._useAgeLoader();
    const identity = await keychain.loadIdentity({ backend: 'passphrase', passphrase: PASS, home: dir });
    assert.equal(typeof identity, 'string');
  } finally { cleanup(dir); }
});

test('a wrong passphrase stays a wrong passphrase', async () => {
  const dir = await vaultHome();
  try {
    const err = await failure({ backend: 'passphrase', passphrase: 'not the passphrase', home: dir });
    assert.equal(err.code, 'ZN_LOCKED');
    assert.equal(err.reason, keychain.WRONG_PASSPHRASE);
    assert.match(err.message, /wrong passphrase/);
    assert.ok(!err.znInstall);
  } finally { cleanup(dir); }
});

test('a really damaged identity.age keeps the damaged message with the reset step', async () => {
  const dir = await vaultHome();
  try {
    const file = store.paths({ home: dir }).identityFile;
    fs.writeFileSync(file, Buffer.from('this is not an age file at all'), { mode: 0o600 });
    const err = await failure({ backend: 'passphrase', passphrase: PASS, home: dir });
    assert.equal(err.code, 'ZN_LOCKED');
    assert.match(err.message, /looks damaged/);
    assert.match(err.message, /vault reset/);
    assert.notEqual(err.reason, keychain.WRONG_PASSPHRASE);
    assert.ok(!err.znInstall);
  } finally { cleanup(dir); }
});
