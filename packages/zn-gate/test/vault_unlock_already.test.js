'use strict';
/* zn unlock on a vault that is already unlocked says so before it asks for the passphrase, and succeeds. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { unlockCmd, ALREADY_UNLOCKED } = require('../lib/vault/cli');

const fakeClient = (status) => () => ({ status: async () => status, close() {} });

test('zn unlock on an unlocked vault returns without reading the passphrase', async () => {
  let asked = 0;
  const write = process.stdout.write;
  let printed = '';
  process.stdout.write = (s) => { printed += s; return true; };
  try {
    await unlockCmd(['unlock'], {
      agent: null,
      clientFactory: fakeClient({ unlocked: true, expiresAt: 'x', features: ['resolve-policy'] }),
      getPassphrase: async () => { asked += 1; return 'fake-pass-12345'; },
    });
  } finally { process.stdout.write = write; }
  assert.equal(asked, 0, 'the passphrase prompt was not reached');
  assert.ok(printed.includes(ALREADY_UNLOCKED));
});
