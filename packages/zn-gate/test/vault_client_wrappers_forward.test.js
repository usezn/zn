'use strict';
// The module-level wrappers of lib/vault/client.js forward their arguments to the matching VaultClient method and return its
// result. Each method is replaced by a recorder, so no daemon is contacted.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'zn-cov56-wrappers-'));
process.env.ZN_HOME = path.join(HOME, '.zn');

const clientMod = require('../lib/vault/client');
const { VaultClient } = clientMod;

const METHODS = ['mapToken', 'resolve', 'setSecret', 'listSecrets', 'removeSecret', 'maskInfo', 'maskSpans', 'exactValues',
  'audit', 'updateSecretMeta', 'isApproved', 'recordApproval', 'confirmFileWrite', 'confirmApproval', 'adoptToken',
  'sameSecretValue', 'readBackup'];

test.after(() => { clientMod.close(); fs.rmSync(HOME, { recursive: true, force: true }); });

test('every module-level wrapper passes its arguments to the client method and returns what it answers', async () => {
  const saved = {};
  const seen = {};
  for (const m of METHODS) {
    saved[m] = Object.getOwnPropertyDescriptor(VaultClient.prototype, m);
    VaultClient.prototype[m] = function recorder(...a) { seen[m] = a; return Promise.resolve('answer-' + m); };
  }
  try {
    const cases = [
      ['mapToken', ['proj', 'type', 'value'], ['proj', 'type', 'value']],
      ['resolve', ['proj', 'tok', 'extra'], ['proj', 'tok', 'extra']],
      ['setSecret', ['NAME', 'v', { a: 1 }], ['NAME', 'v', { a: 1 }]],
      ['listSecrets', [{ agent: 'x' }], [{ agent: 'x' }]],
      ['removeSecret', ['NAME'], ['NAME']],
      ['maskInfo', ['proj', 'claim'], ['proj', 'claim']],
      ['maskSpans', ['proj', ['t1'], 'claim'], ['proj', ['t1'], 'claim']],
      ['exactValues', ['proj'], ['proj']],
      ['audit', [{ kind: 'k' }], [{ kind: 'k' }]],
      ['updateSecretMeta', ['NAME', { m: 1 }], ['NAME', { m: 1 }]],
      ['isApproved', ['proj', 'SECRET', 'argv0'], ['proj', 'SECRET', 'argv0']],
      ['recordApproval', ['proj', 'SECRET', 'argv0'], ['proj', 'SECRET', 'argv0']],
      ['confirmFileWrite', ['proj', 'file', ['n1'], 'why'], ['proj', 'file', ['n1'], 'why']],
      ['confirmApproval', ['kind', 'proj', 'summary'], ['kind', 'proj', 'summary']],
      ['adoptToken', ['proj', 'tok', 'NAME', { m: 2 }], ['proj', 'tok', 'NAME', { m: 2 }]],
      ['sameSecretValue', ['NAME', 'v'], ['NAME', 'v']],
      ['readBackup', ['proj', 'NAME', '/f'], ['proj', 'NAME', '/f']],
    ];
    for (const [name, args, expected] of cases) {
      const answer = await clientMod[name](...args);
      assert.equal(answer, 'answer-' + name, name);
      assert.deepEqual(seen[name].slice(0, expected.length), expected, name);
    }
  } finally {
    for (const m of METHODS) {
      if (saved[m]) Object.defineProperty(VaultClient.prototype, m, saved[m]);
      else delete VaultClient.prototype[m];
    }
    clientMod.close();
  }
});
