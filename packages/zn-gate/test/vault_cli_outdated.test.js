'use strict';
/* zn unlock and zn vault status with a vault process started by an older zn-gate. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { restartIfOutdated, isOutdatedVault, unlockedLine } = require('../lib/vault/cli');

const fakeClient = (status) => () => ({ status: async () => { if (status instanceof Error) throw status; return status; }, close() {} });

test('zn unlock restarts a running vault that lacks resolve-policy', async () => {
  const said = [];
  let locked = 0;
  const restarted = await restartIfOutdated({ clientFactory: fakeClient({ unlocked: true, expiresAt: 'x' }), out: (s) => said.push(s), lock: async () => { locked += 1; return true; } });
  assert.equal(restarted, true);
  assert.equal(locked, 1);
  assert.deepEqual(said, ['The running vault is from an older zn-gate; restarting it.']);
});

test('zn unlock leaves a current vault, or no vault, alone', async () => {
  for (const status of [{ unlocked: true, features: ['resolve-policy'] }, new Error('locked')]) {
    let locked = 0;
    const said = [];
    const restarted = await restartIfOutdated({ clientFactory: fakeClient(status), out: (s) => said.push(s), lock: async () => { locked += 1; } });
    assert.equal(restarted, false);
    assert.equal(locked, 0);
    assert.deepEqual(said, []);
  }
});

test('zn vault status names the version and flags an outdated vault', () => {
  const meta = { backend: 'passphrase' };
  assert.equal(isOutdatedVault(null), false);
  assert.equal(unlockedLine(meta, { expiresAt: 'T', features: ['resolve-policy'], version: '1.8.0' }),
    'Vault: unlocked (backend passphrase, expires T, zn-gate 1.8.0)');
  assert.equal(unlockedLine(meta, { expiresAt: 'T' }),
    'Vault: unlocked (backend passphrase, expires T), outdated: restart with `zn lock`, then `zn unlock`');
});
