'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cloudKey = require('../lib/cloud-key');

const FAKE_KEY = 'zn_example_key_0123456789abcdef';

async function withTempHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-cloud-stores-'));
  const saved = process.env.ZN_HOME;
  process.env.ZN_HOME = path.join(home, '.zn');
  try {
    await fn(path.join(home, '.zn', 'config.json'));
  } finally {
    cloudKey._use(null);
    if (saved === undefined) delete process.env.ZN_HOME; else process.env.ZN_HOME = saved;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function fakeKeychain() {
  let value = null;
  return { name: 'fake', slot: 'slot', impl: { store: (k) => { value = k; }, load: () => value, remove: () => { value = null; } } };
}

// A vault that keeps secrets in memory; `unlocked` decides whether it counts as available.
function fakeVault(unlocked) {
  const secrets = new Map();
  return {
    secrets,
    isUnlocked: async () => unlocked,
    setSecret: async (name, value) => { secrets.set(name, value); },
    resolve: async (cwd, ref, opts) => {
      assert.equal(opts.purpose, cloudKey.RESOLVE_PURPOSE);
      if (!secrets.has(cloudKey.VAULT_SECRET)) throw Object.assign(new Error('missing'), { code: 'ZN_NOT_FOUND' });
      return secrets.get(cloudKey.VAULT_SECRET);
    },
    removeSecret: async (name) => {
      if (!secrets.delete(name)) throw Object.assign(new Error('missing'), { code: 'ZN_NOT_FOUND' });
    },
  };
}

test('availableStore prefers the keychain, then an unlocked vault, else null', async () => {
  assert.equal(await cloudKey.availableStore({ native: fakeKeychain(), vault: fakeVault(true) }), 'keychain');
  assert.equal(await cloudKey.availableStore({ native: null, vault: fakeVault(true) }), 'vault');
  assert.equal(await cloudKey.availableStore({ native: null, vault: fakeVault(false) }), null);
  const broken = { isUnlocked: async () => { throw new Error('vault unreachable'); } };
  assert.equal(await cloudKey.availableStore({ native: null, vault: broken }), null);
});

test('with a working keychain a key is saved, loaded and deleted', async () => {
  await withTempHome(async () => {
    const deps = { native: fakeKeychain(), vault: fakeVault(false) };
    assert.equal(await cloudKey.saveKey(FAKE_KEY, deps), 'keychain');
    assert.deepEqual(await cloudKey.loadStoredKey(deps), { key: FAKE_KEY, store: 'keychain' });
    assert.deepEqual(await cloudKey.deleteKey(deps), { removed: true, store: 'keychain' });
    assert.equal(cloudKey.isConnected(), false);
    assert.equal(await cloudKey.loadStoredKey(deps), null);
  });
});

test('with only an unlocked vault a key is saved, loaded and deleted through the vault', async () => {
  await withTempHome(async () => {
    const vault = fakeVault(true);
    const deps = { native: null, vault };
    assert.equal(await cloudKey.saveKey(FAKE_KEY, deps), 'vault');
    assert.equal(vault.secrets.get(cloudKey.VAULT_SECRET), FAKE_KEY);
    assert.deepEqual(await cloudKey.loadStoredKey(deps), { key: FAKE_KEY, store: 'vault' });
    assert.deepEqual(await cloudKey.deleteKey(deps), { removed: true, store: 'vault' });
    assert.equal(vault.secrets.size, 0);
    assert.equal(cloudKey.isConnected(), false);
  });
});

test('without any secure store saveKey throws NoSecureStore and writes nothing', async () => {
  await withTempHome(async (file) => {
    const deps = { native: null, vault: fakeVault(false) };
    await assert.rejects(cloudKey.saveKey(FAKE_KEY, deps), (e) => {
      assert.ok(e instanceof cloudKey.NoSecureStore);
      assert.equal(e.code, 'ZN_NO_SECURE_STORE');
      return true;
    });
    assert.equal(cloudKey.isConnected(), false);
    assert.equal(fs.existsSync(file), false);
  });
});

test('saveKey refuses an unusable key before it looks at any store', async () => {
  const deps = { native: fakeKeychain(), vault: fakeVault(true) };
  await assert.rejects(cloudKey.saveKey('short', deps), /not a usable API key/);
});

test('deleting a key that was never saved changes nothing', async () => {
  await withTempHome(async (file) => {
    const deps = { native: fakeKeychain(), vault: fakeVault(true) };
    assert.deepEqual(await cloudKey.deleteKey(deps), { removed: false, store: null });
    assert.equal(fs.existsSync(file), false);
  });
});

test('deleting from a vault that no longer has the secret still clears the marker', async () => {
  await withTempHome(async () => {
    const vault = fakeVault(true);
    const deps = { native: null, vault };
    await cloudKey.saveKey(FAKE_KEY, deps);
    vault.secrets.clear();
    assert.deepEqual(await cloudKey.deleteKey(deps), { removed: true, store: 'vault' });
    assert.equal(cloudKey.isConnected(), false);
  });
});

test('a failing vault delete keeps the marker so a second try can find it', async () => {
  await withTempHome(async () => {
    const vault = fakeVault(true);
    const deps = { native: null, vault };
    await cloudKey.saveKey(FAKE_KEY, deps);
    vault.removeSecret = async () => { throw Object.assign(new Error('vault is locked'), { code: 'ZN_LOCKED' }); };
    const r = await cloudKey.deleteKey(deps);
    assert.equal(r.removed, false);
    assert.equal(r.store, 'vault');
    assert.match(r.error.message, /locked/);
    assert.equal(cloudKey.isConnected(), true);
  });
});
