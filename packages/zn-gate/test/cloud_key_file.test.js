'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cloudKey = require('../lib/cloud-key');

const FAKE_KEY = 'zn_example_key_0123456789abcdef';
const posix = process.platform !== 'win32';

// Run fn with HOME (and USERPROFILE) pointing at a fresh temp dir and ZN_HOME unset.
async function withTempHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-cloud-key-'));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, ZN_HOME: process.env.ZN_HOME };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.ZN_HOME;
  try {
    await fn(home, path.join(home, '.zn', 'config.json'));
  } finally {
    cloudKey._use(null);
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function fakeKeychain() {
  let value = null;
  return {
    native: { name: 'fake', slot: 'slot', impl: { store: (k) => { value = k; }, load: () => value, remove: () => { value = null; } } },
    vault: { isUnlocked: async () => false },
  };
}

test('missing file: no marker, not connected, nothing stored', async () => {
  await withTempHome(async () => {
    cloudKey._use(fakeKeychain());
    assert.equal(cloudKey.readMarker(), null);
    assert.equal(cloudKey.isConnected(), false);
    assert.equal(await cloudKey.loadStoredKey(), null);
    assert.deepEqual(await cloudKey.deleteKey(), { removed: false, store: null });
  });
});

test('saveKey writes the marker under HOME/.zn/config.json without the key', async () => {
  await withTempHome(async (home, file) => {
    cloudKey._use(fakeKeychain());
    assert.equal(await cloudKey.saveKey(FAKE_KEY), 'keychain');
    assert.ok(fs.existsSync(file));
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(!text.includes(FAKE_KEY));
    const cfg = JSON.parse(text);
    assert.equal(cfg.cloud.store, 'keychain');
    assert.equal(cfg.cloud.last4, FAKE_KEY.slice(-4));
    const marker = cloudKey.readMarker();
    assert.equal(marker.store, 'keychain');
    assert.equal(marker.last4, FAKE_KEY.slice(-4));
    assert.match(marker.connectedAt, /^\d{4}-\d\d-\d\dT/);
    assert.equal(cloudKey.isConnected(), true);
    assert.deepEqual(await cloudKey.loadStoredKey(), { key: FAKE_KEY, store: 'keychain' });
  });
});

test('config file is written with mode 0600 and the directory with 0700 on POSIX', { skip: !posix }, async () => {
  await withTempHome(async (home, file) => {
    cloudKey._use(fakeKeychain());
    await cloudKey.saveKey(FAKE_KEY);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
    // A rewrite keeps the mode and leaves no temp file behind.
    await cloudKey.deleteKey();
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['config.json']);
  });
});

test('writing the marker keeps other settings in the file', async () => {
  await withTempHome(async (home, file) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ other: { a: 1 } }));
    cloudKey._use(fakeKeychain());
    await cloudKey.saveKey(FAKE_KEY);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).other, { a: 1 });
    cloudKey.forgetMarker();
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(cfg, { other: { a: 1 } });
    assert.equal(cloudKey.isConnected(), false);
  });
});

test('malformed file: treated as no marker and replaced on the next save', async () => {
  await withTempHome(async (home, file) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    for (const bad of ['{not json', '', 'null', '[]', '"text"', '{"cloud":"x"}', '{"cloud":{"store":"file"}}']) {
      fs.writeFileSync(file, bad);
      assert.equal(cloudKey.readMarker(), null, JSON.stringify(bad));
      assert.equal(cloudKey.isConnected(), false);
      assert.equal(await cloudKey.loadStoredKey(), null);
    }
    fs.writeFileSync(file, '{not json');
    cloudKey._use(fakeKeychain());
    await cloudKey.saveKey(FAKE_KEY);
    assert.equal(cloudKey.readMarker().store, 'keychain');
  });
});

test('marker with a bad last4 or connectedAt is read with those fields null', async () => {
  await withTempHome(async (home, file) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ cloud: { store: 'vault', connectedAt: 5, last4: 'a b!' } }));
    assert.deepEqual(cloudKey.readMarker(), { store: 'vault', connectedAt: null, last4: null });
  });
});

test('a marker that does not match the stored key loads nothing', async () => {
  await withTempHome(async (home, file) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ cloud: { store: 'keychain', last4: 'zzzz' } }));
    const deps = fakeKeychain();
    deps.native.impl.store(FAKE_KEY);
    cloudKey._use(deps);
    assert.equal(await cloudKey.loadStoredKey(), null);
  });
});

test('ZN_HOME overrides HOME for the config location', async () => {
  await withTempHome(async (home) => {
    const other = path.join(home, 'custom');
    process.env.ZN_HOME = other;
    cloudKey._use(fakeKeychain());
    await cloudKey.saveKey(FAKE_KEY);
    assert.ok(fs.existsSync(path.join(other, 'config.json')));
    assert.ok(!fs.existsSync(path.join(home, '.zn')));
  });
});
