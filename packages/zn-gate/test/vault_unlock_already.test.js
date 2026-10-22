'use strict';
/* zn unlock on a vault that is already unlocked says so before it asks for the passphrase, and exits 0. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { unlockCmd, ALREADY_UNLOCKED } = require('../lib/vault/cli');

const fakeClient = (status) => () => ({ status: async () => status, close() {} });

test('zn unlock on an unlocked vault says so, exits 0 and does not read the passphrase', async () => {
  let asked = 0;
  const written = [];
  const realWrite = process.stdout.write;
  process.stdout.write = (chunk) => { written.push(String(chunk)); return true; };
  let code;
  try {
    code = await unlockCmd(['unlock'], {
      agent: null,
      clientFactory: fakeClient({ unlocked: true, expiresAt: 'x', features: ['resolve-policy'] }),
      getPassphrase: async () => { asked += 1; return 'fake-pass-12345'; },
    });
  } finally {
    process.stdout.write = realWrite;
  }
  assert.equal(code, 0, 'nothing to do is not a failure');
  assert.equal(written.join('').trim(), ALREADY_UNLOCKED);
  assert.equal(asked, 0, 'the passphrase prompt was not reached');
});
