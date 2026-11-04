'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const cloudKey = require('../lib/cloud-key');

const FAKE_KEY = 'zn_example_key_0123456789abcdef';

test.afterEach(() => cloudKey._use(null));

test('usableApiKey trims a valid key and returns it', () => {
  assert.equal(cloudKey.usableApiKey('  ' + FAKE_KEY + '\n'), FAKE_KEY);
});

test('usableApiKey returns null for non-strings, blanks and short values', () => {
  for (const v of [undefined, null, 42, {}, '', '   ', 'short_key']) {
    assert.equal(cloudKey.usableApiKey(v), null);
  }
});

test('usableApiKey returns null for unexpanded placeholders and odd characters', () => {
  for (const v of ['${user_config.api_key}', '%ZN_API_KEY%', 'zn_example key 0123456789', 'zn_example/key/0123456789']) {
    assert.equal(cloudKey.usableApiKey(v), null);
  }
});

test('usableApiKey accepts 16 characters and refuses 15 or more than 256', () => {
  assert.equal(cloudKey.usableApiKey('a'.repeat(16)), 'a'.repeat(16));
  assert.equal(cloudKey.usableApiKey('a'.repeat(15)), null);
  assert.equal(cloudKey.usableApiKey('a'.repeat(256)), 'a'.repeat(256));
  assert.equal(cloudKey.usableApiKey('a'.repeat(257)), null);
});

test('looksLikeZnKey wants the zn_ prefix on a usable key', () => {
  assert.equal(cloudKey.looksLikeZnKey(FAKE_KEY), true);
  assert.equal(cloudKey.looksLikeZnKey('  ' + FAKE_KEY + ' '), true);
  assert.equal(cloudKey.looksLikeZnKey('sk_example_key_0123456789abcdef'), false);
  assert.equal(cloudKey.looksLikeZnKey('zn_short'), false);
  assert.equal(cloudKey.looksLikeZnKey('zn_${placeholder}_0123456789'), false);
  assert.equal(cloudKey.looksLikeZnKey(null), false);
});

test('availableStore prefers the keychain, then an unlocked vault, else null', async () => {
  const native = { name: 'fake', impl: {}, slot: 's' };
  const unlocked = { isUnlocked: async () => true };
  const locked = { isUnlocked: async () => false };
  assert.equal(await cloudKey.availableStore({ native, vault: unlocked }), 'keychain');
  assert.equal(await cloudKey.availableStore({ native: null, vault: unlocked }), 'vault');
  assert.equal(await cloudKey.availableStore({ native: null, vault: locked }), null);
});

test('availableStore treats a vault that throws as locked', async () => {
  const vault = { isUnlocked: async () => { throw new Error('no daemon'); } };
  assert.equal(await cloudKey.availableStore({ native: null, vault }), null);
});

test('availableStore uses the backends set with _use when no deps are passed', async () => {
  cloudKey._use({ native: null, vault: { isUnlocked: async () => true } });
  assert.equal(await cloudKey.availableStore(), 'vault');
});

test('NoSecureStore is an Error with a stable code and message', () => {
  const e = new cloudKey.NoSecureStore();
  assert.ok(e instanceof Error);
  assert.equal(e.code, 'ZN_NO_SECURE_STORE');
  assert.match(e.message, /no secure place/);
});

test('saveKey throws NoSecureStore when nothing can hold the key', async () => {
  await assert.rejects(
    cloudKey.saveKey(FAKE_KEY, { native: null, vault: { isUnlocked: async () => false } }),
    (e) => e instanceof cloudKey.NoSecureStore,
  );
});

test('RESOLVE_PURPOSE is the purpose the vault is asked with', () => {
  assert.equal(cloudKey.RESOLVE_PURPOSE, 'zn-cloud-key');
});
