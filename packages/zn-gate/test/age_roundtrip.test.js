'use strict';
/**
 * The vault's encryption library (age-encryption and its @noble dependencies) declares Node.js 20.19 or
 * later, while zn-gate supports Node.js 18. This test runs the vault's own age round trip (identity,
 * encrypt to a recipient, decrypt, and the passphrase form) in a child process with no global WebCrypto,
 * the state of Node.js 18, so every Node.js version in the CI matrix proves the built-in fallback works.
 * Fake values only.
 */
process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

const STORE = path.join(__dirname, '..', 'lib', 'vault', 'store.js');

const CHILD = `
const store = require(process.argv[1]);
(async () => {
  try { delete globalThis.crypto; } catch (_e) { /* Node.js 18 has none */ }
  const { identity, recipient } = await store.generateIdentity();
  const secret = 'FAKE-VALUE-not-a-real-secret-123';
  const ct = await store.encryptTo(recipient, secret);
  const back = await store.decryptWith(identity, ct);
  const pct = await store.encryptWithPassphrase('example-passphrase', secret, 10);
  const pback = await store.decryptWithPassphrase('example-passphrase', pct);
  console.log(JSON.stringify({ ok: back === secret && pback === secret, armored: Buffer.from(ct).toString('latin1').startsWith('age-encryption.org/v1') }));
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
`;

test('vault age round trip works with the built-in WebCrypto fallback on this Node.js', () => {
  const r = spawnSync(process.execPath, ['-e', CHILD, STORE], { encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(out.ok, true);
  assert.equal(out.armored, true);
});
