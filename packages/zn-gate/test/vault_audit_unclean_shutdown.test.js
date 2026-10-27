'use strict';
/*
 * A crash (kill -9, power loss) can land between an audit append and the save
 * of the vault's checkpoint. The log then verifies and carries the checkpoint
 * record but has records after it. The next unlock adopts those records, and
 * says so in the log. If the extra records do not verify, the unlock refuses
 * to adopt them and keeps the tamper mark.
 * The crash is simulated by putting back the checkpoint file from before the
 * last writes: the same state a kill between append and save leaves behind.
 * Runs the real daemon and client against a temporary ZN_HOME.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const crypto = require('crypto');
const { tempDir } = require('./helpers/tmp');

process.env.ZN_KEYCHAIN_BACKEND = 'passphrase';
const keychain = require('../lib/vault/keychain');
const daemon = require('../lib/vault/daemon');
const clientMod = require('../lib/vault/client');
const store = require('../lib/vault/store');

const fake = (n) => crypto.randomBytes(n).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, n);

async function harness(t) {
  process.env.ZN_HOME = tempDir(t, 'znun-');
  const created = await keychain.initIdentity({ passphrase: 'correct horse battery staple', workFactor: 10 });
  const identity = created.identity || created;
  const opts = { identity, ttlMs: 60000, idleMs: 60000, confirm: async () => true };
  const h = { srv: null, c: null };
  h.unlock = async () => { h.srv = await daemon.serve(opts); h.c = clientMod.createClient({}); };
  h.lock = async () => { h.c.close(); await h.srv.close(); h.srv = null; h.c = null; };
  h.file = () => store.paths().auditFile;
  h.lines = () => fs.readFileSync(h.file(), 'utf8').trim().split('\n');
  h.records = () => h.lines().map((l) => JSON.parse(l));
  h.set = (i) => h.c.setSecret('K' + i, 'value-' + i + '-' + fake(10), { mode: 'env' });
  t.after(async () => { if (h.srv) await h.lock(); });
  await h.unlock();
  return h;
}

/* Locked vault with a checkpoint at N records and a log that grew by `extra` records past it. */
async function crashed(h, extra) {
  for (let i = 0; i < 3; i++) await h.set(i);
  await h.lock();
  const checkpointFile = store.paths().secretsFile;
  const old = fs.readFileSync(checkpointFile);
  const checkpointed = h.lines().length;
  await h.unlock();
  for (let i = 0; i < extra; i++) await h.set(10 + i);
  await h.lock();
  assert.ok(h.lines().length >= checkpointed + extra);
  fs.writeFileSync(checkpointFile, old); // the save after the last appends never happened
  return checkpointed;
}

test('unclean shutdown: the tail past the checkpoint is adopted, verify is ok, and a warn record says so', async (t) => {
  const h = await harness(t);
  const checkpointed = await crashed(h, 2);
  const grown = h.lines().length;
  await h.unlock();
  const v = await h.c.auditVerify();
  assert.strictEqual(v.ok, true, JSON.stringify(v));
  const recs = h.records();
  const adopted = grown - checkpointed;
  assert.ok(adopted >= 2);
  const warn = recs.filter((r) => r.decision === 'warn');
  assert.strictEqual(warn.length, 1, JSON.stringify(warn));
  assert.strictEqual(warn[0].reason, 'audit_tail_adopted_after_unclean_shutdown:' + adopted);
  assert.strictEqual(warn[0].mode, 'unlock');
  // The warn record comes right after the adopted tail, then the ordinary unlock record.
  assert.strictEqual(warn[0].seq, recs[grown - 1].seq + 1);
  assert.strictEqual(recs[recs.length - 1].decision, 'allow');
  // It survives a normal lock and unlock, and is not repeated.
  await h.lock();
  await h.unlock();
  assert.strictEqual((await h.c.auditVerify()).ok, true);
  assert.strictEqual(h.records().filter((r) => r.decision === 'warn').length, 1);
});

test('clean lock and unlock never write the warn record', async (t) => {
  const h = await harness(t);
  for (let i = 0; i < 3; i++) await h.set(i);
  await h.lock();
  await h.unlock();
  assert.strictEqual((await h.c.auditVerify()).ok, true);
  assert.strictEqual(h.records().filter((r) => r.decision === 'warn').length, 0);
});

test('unclean shutdown with a tampered tail: not adopted, reported, and marked', async (t) => {
  const h = await harness(t);
  await crashed(h, 2);
  // Same-length edit of the last record past the checkpoint.
  const l = h.lines();
  const rec = JSON.parse(l[l.length - 1]);
  rec.decision = rec.decision === 'deny' ? 'allow' : 'deny';
  l[l.length - 1] = JSON.stringify(rec);
  fs.writeFileSync(h.file(), l.join('\n') + '\n');
  await h.unlock();
  const v = await h.c.auditVerify();
  assert.strictEqual(v.ok, false, JSON.stringify(v));
  assert.strictEqual(v.tampered, true);
  assert.strictEqual(h.records().filter((r) => r.reason && /audit_tail_adopted/.test(r.reason)).length, 0);
  // The mark persists across lock and unlock.
  await h.lock();
  await h.unlock();
  assert.strictEqual((await h.c.auditVerify()).tampered, true);
});
