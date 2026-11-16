'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cloudKey = require('../lib/cloud-key');

const STORED = 'zn_example_stored_0123456789';
const ENV = 'zn_example_env_0123456789ab';
const FLAG = 'zn_example_flag_0123456789a';

function fakeKeychain() {
  let value = null;
  return {
    native: { name: 'fake', slot: 'slot', impl: { store: (k) => { value = k; }, load: () => value, remove: () => { value = null; } } },
    vault: { isUnlocked: async () => false },
  };
}

// Run fn with a temporary ZN_HOME and a controlled ZN_API_KEY, then restore both.
async function withEnv(envKey, fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-resolve-order-'));
  const saved = { ZN_HOME: process.env.ZN_HOME, ZN_API_KEY: process.env.ZN_API_KEY };
  process.env.ZN_HOME = home;
  if (envKey === undefined) delete process.env.ZN_API_KEY; else process.env.ZN_API_KEY = envKey;
  try {
    await fn();
  } finally {
    cloudKey._use(null);
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
}

async function withStored(deps) {
  cloudKey._use(deps);
  assert.equal(await cloudKey.saveKey(STORED), 'keychain');
}

test('an explicit option wins over the environment and the stored key', async () => {
  await withEnv(ENV, async () => {
    const deps = fakeKeychain();
    await withStored(deps);
    assert.deepEqual(await cloudKey.resolveApiKey({ apiKey: FLAG }, deps), { key: FLAG, source: 'flag' });
  });
});

test('the environment wins over the stored key', async () => {
  await withEnv(ENV, async () => {
    const deps = fakeKeychain();
    await withStored(deps);
    assert.deepEqual(await cloudKey.resolveApiKey({}, deps), { key: ENV, source: 'environment' });
  });
});

test('the stored key is used when no option or environment value is set', async () => {
  await withEnv(undefined, async () => {
    const deps = fakeKeychain();
    await withStored(deps);
    assert.deepEqual(await cloudKey.resolveApiKey({}, deps), { key: STORED, source: 'keychain' });
  });
});

test('nothing set gives null', async () => {
  await withEnv(undefined, async () => {
    assert.equal(await cloudKey.resolveApiKey({}, fakeKeychain()), null);
    assert.equal(await cloudKey.resolveApiKey(undefined, fakeKeychain()), null);
  });
});

test('an empty option is ignored and the environment is used', async () => {
  await withEnv(ENV, async () => {
    assert.deepEqual(await cloudKey.resolveApiKey({ apiKey: '' }, fakeKeychain()), { key: ENV, source: 'environment' });
  });
});

test('a whitespace-only option is ignored and the stored key is used', async () => {
  await withEnv(ENV, async () => {
    const deps = fakeKeychain();
    await withStored(deps);
    for (const blank of ['   ', '\t\n']) {
      assert.deepEqual(await cloudKey.resolveApiKey({ apiKey: blank }, deps), { key: STORED, source: 'keychain' });
    }
  });
});

test('a blank environment value is ignored and the stored key is used', async () => {
  for (const blank of ['', '   ']) {
    await withEnv(blank, async () => {
      const deps = fakeKeychain();
      await withStored(deps);
      assert.deepEqual(await cloudKey.resolveApiKey({}, deps), { key: STORED, source: 'keychain' });
    });
  }
});

test('blank option and blank environment with nothing stored give null', async () => {
  await withEnv('  ', async () => {
    assert.equal(await cloudKey.resolveApiKey({ apiKey: ' ' }, fakeKeychain()), null);
  });
});
