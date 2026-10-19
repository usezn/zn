'use strict';
/* zn unlock on a vault that is already unlocked says so before it asks for the passphrase. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { unlockCmd, ALREADY_UNLOCKED } = require('../lib/vault/cli');

const fakeClient = (status) => () => ({ status: async () => status, close() {} });

test('zn unlock on an unlocked vault exits without reading the passphrase', async () => {
  let asked = 0;
  await assert.rejects(unlockCmd(['unlock'], {
    agent: null,
    clientFactory: fakeClient({ unlocked: true, expiresAt: 'x', features: ['resolve-policy'] }),
    getPassphrase: async () => { asked += 1; return 'fake-pass-12345'; },
  }), (err) => err.message === ALREADY_UNLOCKED);
  assert.equal(asked, 0, 'the passphrase prompt was not reached');
});
