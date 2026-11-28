'use strict';
/*
 * Vault daemon: foreground unlock (unlockForeground) and the team sync timer (teamSync in serve).
 * Fake vault in a temporary HOME (under TMPDIR), passphrase backend only, no keychain, no network:
 * the sync timer runs against a fetch stub that counts calls and never answers.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');
const { tempDir } = require('./helpers/tmp');

const PASS = 'correct horse battery staple';
const WRONG = 'wrong horse battery staple';
const LONG_VALUE = 'fake-value-0123456789';

const savedEnv = {
  HOME: process.env.HOME,
  ZN_HOME: process.env.ZN_HOME,
  ZN_KEYCHAIN_BACKEND: process.env.ZN_KEYCHAIN_BACKEND,
};
process.env.ZN_KEYCHAIN_BACKEND = 'passphrase';

const daemon = require('../lib/vault/daemon');
const keychain = require('../lib/vault/keychain');
const store = require('../lib/vault/store');
const { createClient } = require('../lib/vault/client');
const { CODES } = require('../lib/errors');
const messages = require('../lib/messages');

/* A temporary HOME and ZN_HOME for this test only; restored and removed when the test ends. */
function fakeHome(t) {
  const base = process.env.TMPDIR || os.tmpdir();
  const home = tempDir(t, 'znfg-home-', base);
  const zn = path.join(home, '.zn');
  process.env.HOME = home;
  process.env.ZN_HOME = zn;
  t.after(() => {
    for (const k of Object.keys(savedEnv)) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });
  return zn;
}

const streams = () => ({ input: new PassThrough(), output: new PassThrough() });

const foregroundOpts = (zn, extra) => ({
  home: zn,
  passphrase: PASS,
  workFactor: 10,
  ttlMs: 60000,
  idleMs: 60000,
  ...streams(),
  ...(extra || {}),
});

test('unlockForeground creates the vault on first use, is unlocked, and ends on close()', async (t) => {
  const zn = fakeHome(t);
  const u = await daemon.unlockForeground(foregroundOpts(zn));
  assert.strictEqual(u.created, true);
  assert.match(u.expiresAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/);
  const c = createClient({});
  try {
    assert.strictEqual((await c.status()).unlocked, true);
  } finally {
    c.close();
  }
  u.close();
  await u.done;
  assert.strictEqual(await daemon.isRunning({ home: zn }), false);
});

test('unlockForeground on an existing vault reports created false', async (t) => {
  const zn = fakeHome(t);
  const first = await daemon.unlockForeground(foregroundOpts(zn));
  first.close();
  await first.done;
  const again = await daemon.unlockForeground(foregroundOpts(zn));
  assert.strictEqual(again.created, false);
  again.close();
  await again.done;
});

test('unlockForeground with a wrong passphrase refuses and starts no daemon', async (t) => {
  const zn = fakeHome(t);
  const first = await daemon.unlockForeground(foregroundOpts(zn));
  first.close();
  await first.done;
  await assert.rejects(daemon.unlockForeground(foregroundOpts(zn, { passphrase: WRONG })), (err) => err.code === CODES.LOCKED);
  assert.strictEqual(await daemon.isRunning({ home: zn }), false);
});

test('unlockForeground with init false and no vault refuses and creates nothing', async (t) => {
  const zn = fakeHome(t);
  await assert.rejects(daemon.unlockForeground(foregroundOpts(zn, { init: false })), (err) => err.code === CODES.NOT_FOUND);
  assert.ok(!keychain.readMeta({ home: zn }), 'no vault metadata was written');
  assert.strictEqual(await daemon.isRunning({ home: zn }), false);
});

test('unlockForeground while the vault is already unlocked refuses before it reads the passphrase', async (t) => {
  const zn = fakeHome(t);
  const u = await daemon.unlockForeground(foregroundOpts(zn));
  t.after(async () => { u.close(); await u.done; });
  await assert.rejects(
    daemon.unlockForeground(foregroundOpts(zn, { passphrase: undefined })),
    (err) => err.code === CODES.POLICY_DENIED && err.message === messages.vaultAlreadyUnlocked(),
  );
});

test('team sync timer outside a team runs without calling the server and leaves the vault unlocked', async (t) => {
  const zn = fakeHome(t);
  const created = await keychain.initIdentity({ home: zn, passphrase: PASS, workFactor: 10 });
  const identity = created.identity || created;
  let fetchCalls = 0;
  const fetchImpl = async () => { fetchCalls += 1; throw new Error('the test network is closed'); };
  const srv = await daemon.serve({ home: zn, identity, ttlMs: 60000, idleMs: 60000, confirm: async () => true, teamSyncMs: 20, fetchImpl });
  const c = createClient({});
  t.after(async () => { c.close(); await srv.close(); });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.strictEqual((await c.status()).unlocked, true);
  assert.strictEqual(fetchCalls, 0, 'no organization policy is fetched without a team');
});

test('teamSync timer disabled with teamSyncMs 0 never runs the sync', async (t) => {
  const zn = fakeHome(t);
  const created = await keychain.initIdentity({ home: zn, passphrase: PASS, workFactor: 10 });
  const identity = created.identity || created;
  let fetchCalls = 0;
  const fetchImpl = async () => { fetchCalls += 1; throw new Error('the test network is closed'); };
  const srv = await daemon.serve({ home: zn, identity, ttlMs: 60000, idleMs: 60000, confirm: async () => true, teamSyncMs: 0, fetchImpl });
  const c = createClient({});
  t.after(async () => { c.close(); await srv.close(); });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.strictEqual(fetchCalls, 0);
});

test('an unreadable audit log while unlocking: the daemon refuses to start and stays down', async (t) => {
  const zn = fakeHome(t);
  const created = await keychain.initIdentity({ home: zn, passphrase: PASS, workFactor: 10 });
  const identity = created.identity || created;
  const srv = await daemon.serve({ home: zn, identity, ttlMs: 60000, idleMs: 60000, confirm: async () => true, teamSyncMs: 0 });
  const c = createClient({});
  await c.setSecret('FAKE_KEY_ONE', LONG_VALUE, { mode: 'env' });
  c.close();
  await srv.close();
  // The audit log cannot be read: a directory sits where the file is.
  const auditFile = store.paths().auditFile;
  fs.rmSync(auditFile, { force: true });
  fs.mkdirSync(auditFile);
  const loaded = await keychain.loadIdentity({ home: zn, passphrase: PASS });
  await assert.rejects(
    daemon.serve({ home: zn, identity: loaded, ttlMs: 60000, idleMs: 60000, confirm: async () => true, teamSyncMs: 0 }),
    (err) => err.code === CODES.LOCKED,
  );
  assert.strictEqual(await daemon.isRunning({ home: zn }), false);
});

test('endpoint ACL branch on Windows (ensurePrivate on the key file, ensurePipe)', {
  skip: 'needs a Windows host: the branch runs only when the endpoint is not a Unix socket; the ACL checks are covered by vault_winacl tests',
}, () => {});

test('teamSync with a joined team or pending revocations uploads through the team ops', {
  skip: 'needs a joined team fixture; the sync itself is covered by team_offline and team_leave_revocation tests',
}, () => {});
