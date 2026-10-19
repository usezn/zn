'use strict';

// approvalStore (lib/broker/approvals.js): the store a vault-less setup gets, the pass-through to the
// vault with and without the `zn run` context, and failures of the vault. Approvals are persistent by
// design (they end only when the program changes or the vault entry is removed); there is no expiry
// and no single-use rule, and the tests pin that. Fake vault and fictitious values only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { approvalStore } = require('../lib/broker/approvals');
const { createFakeVault } = require('./helpers/fake_vault');
const { tempDir } = require('./helpers/tmp');

test('without a vault that can approve, nothing is approved and nothing can be recorded', async () => {
  for (const arg of [undefined, {}, { vault: null }, { vault: {} }, { vault: { isApproved() {} } }, { vault: { recordApproval() {} } }]) {
    const store = approvalStore(arg);
    assert.equal(store.kind, 'none');
    assert.equal(await store.isApproved('DEMO_TOKEN', 'node'), false);
    await assert.rejects(store.recordApproval('DEMO_TOKEN', 'node'), (e) => e.code === 'ZN_LOCKED' && /cannot record approvals/.test(e.message));
  }
});

test('an unknown pair is not approved; recording it approves exactly that pair', async () => {
  const vault = createFakeVault({ withApprovals: true });
  const store = approvalStore({ vault });
  assert.equal(store.kind, 'vault');
  assert.equal(await store.isApproved('DEMO_TOKEN', 'node'), false);
  assert.equal(await store.isApproved('', ''), false);
  await store.recordApproval('DEMO_TOKEN', 'node');
  assert.equal(await store.isApproved('DEMO_TOKEN', 'node'), true);
  assert.equal(await store.isApproved('DEMO_TOKEN', 'python'), false, 'another command');
  assert.equal(await store.isApproved('OTHER_TOKEN', 'node'), false, 'another secret');
});

test('an approval stays valid on every later check and recording it again keeps it', async () => {
  const vault = createFakeVault({ withApprovals: true });
  const store = approvalStore({ vault });
  await store.recordApproval('DEMO_TOKEN', 'node');
  for (let i = 0; i < 3; i++) assert.equal(await store.isApproved('DEMO_TOKEN', 'node'), true);
  await store.recordApproval('DEMO_TOKEN', 'node');
  assert.equal(await store.isApproved('DEMO_TOKEN', 'node'), true);
});

test('with a run context the project and the executable go to the vault; without it only the pair', async () => {
  const vault = createFakeVault({ withApprovals: true });
  const store = approvalStore({ vault });
  const executable = { real: '/usr/bin/node', fp: 'fp-demo' };
  await store.recordApproval('DEMO_TOKEN', 'node', { project: '/work/app', executable });
  assert.equal(await store.isApproved('DEMO_TOKEN', 'node', { project: '/work/app', executable }), true);
  await store.isApproved('DEMO_TOKEN', 'node');
  const [rec, withCtx, plain] = vault.calls;
  assert.equal(rec.op, 'recordApproval');
  assert.equal(rec.project, '/work/app');
  assert.deepEqual(rec.executable, executable);
  assert.equal(withCtx.project, '/work/app');
  assert.equal(plain.project, undefined);
  assert.equal(plain.executable, undefined);
});

test('a context without a project is ignored; one without an executable passes undefined', async () => {
  const seen = [];
  const vault = {
    async isApproved(...a) { seen.push(a); return false; },
    async recordApproval(...a) { seen.push(a); },
  };
  const store = approvalStore({ vault });
  await store.isApproved('S', 'c', {});
  await store.isApproved('S', 'c', { project: null, executable: { real: '/x', fp: 'f' } });
  await store.isApproved('S', 'c', { project: '/p' });
  assert.deepEqual(seen[0], ['S', 'c']);
  assert.deepEqual(seen[1], ['S', 'c']);
  assert.deepEqual(seen[2], ['/p', 'S', 'c', undefined]);
});

test('a vault that declines or fails never turns into an approval', async () => {
  const declined = createFakeVault({ withApprovals: true, confirm: async () => false });
  const store = approvalStore({ vault: declined });
  await assert.rejects(store.recordApproval('DEMO_TOKEN', 'node'), (e) => e.code === 'ZN_POLICY_DENIED');
  assert.equal(await store.isApproved('DEMO_TOKEN', 'node'), false);

  const broken = approvalStore({
    vault: {
      async isApproved() { throw Object.assign(new Error('vault file failed its integrity check'), { code: 'ZN_LOCKED' }); },
      async recordApproval() { throw Object.assign(new Error('vault is locked'), { code: 'ZN_LOCKED' }); },
    },
  });
  // The error reaches the caller: it is never swallowed into `true`.
  await assert.rejects(broken.isApproved('DEMO_TOKEN', 'node'), (e) => e.code === 'ZN_LOCKED');
  await assert.rejects(broken.recordApproval('DEMO_TOKEN', 'node'), (e) => e.code === 'ZN_LOCKED');
});

test('a corrupt or truncated vault file is refused by the real daemon, so no approval can be read from it', async (t) => {
  const home = tempDir(t, 'zn-appr-');
  const saved = { ZN_HOME: process.env.ZN_HOME, ZN_KEYCHAIN_BACKEND: process.env.ZN_KEYCHAIN_BACKEND };
  process.env.ZN_HOME = home;
  process.env.ZN_KEYCHAIN_BACKEND = 'passphrase';
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
  const keychain = require('../lib/vault/keychain');
  const daemon = require('../lib/vault/daemon');
  const store = require('../lib/vault/store');
  const { identity } = await keychain.initIdentity({ passphrase: 'correct horse battery staple', workFactor: 10 });
  const start = () => daemon.serve({ identity, ttlMs: 60000, idleMs: 60000, confirm: async () => true });

  // First start creates the vault file; close and reopen to prove it is readable.
  let srv = await start();
  await srv.close();
  const secretsFile = store.paths().secretsFile;
  assert.ok(path.resolve(secretsFile).startsWith(path.resolve(home)), 'the test never touches the real vault directory');
  const original = fs.readFileSync(secretsFile);
  srv = await start();
  await srv.close();

  for (const bad of [Buffer.alloc(0), original.subarray(0, Math.floor(original.length / 2)), Buffer.from('not an age file')]) {
    fs.writeFileSync(secretsFile, bad);
    await assert.rejects(start(), (e) => e.code === 'ZN_LOCKED', 'the daemon must not start on a damaged vault');
  }
  fs.writeFileSync(secretsFile, original);
  srv = await start();
  await srv.close();
});
