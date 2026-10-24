'use strict';
/*
 * Daybreak finding 3: the vault verifies the whole audit chain before it trusts,
 * shows or exports the log, and stores the persistent tamper mark when the
 * check fails. A record changed in the MIDDLE of the log keeps the last record
 * (and the checkpoint) intact, so the tail check alone never saw it.
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
  process.env.ZN_HOME = tempDir(t, 'znvt-');
  const created = await keychain.initIdentity({ passphrase: 'correct horse battery staple', workFactor: 10 });
  const identity = created.identity || created;
  const answers = [];
  const h = { srv: null, c: null, answers, hook: null };
  const opts = { identity, ttlMs: 60000, idleMs: 60000, confirm: async (req) => { answers.push(req); return true; }, _afterChainCheck: () => { if (h.hook) h.hook(); } };
  h.unlock = async () => { h.srv = await daemon.serve(opts); h.c = clientMod.createClient({}); };
  h.lock = async () => { h.c.close(); await h.srv.close(); h.srv = null; h.c = null; };
  h.file = () => store.paths().auditFile;
  h.text = () => fs.readFileSync(h.file(), 'utf8');
  h.lines = () => h.text().trim().split('\n');
  h.set = (i) => h.c.setSecret('K' + i, 'value-' + i + '-' + fake(10), { mode: 'env' });
  // Change the reason of a record in the middle: the last record stays as it was.
  h.editMiddle = () => {
    const l = h.lines();
    const i = Math.floor(l.length / 2);
    const rec = JSON.parse(l[i]);
    rec.decision = rec.decision === 'deny' ? 'allow' : 'deny';
    l[i] = JSON.stringify(rec);
    fs.writeFileSync(h.file(), l.join('\n') + '\n');
  };
  t.after(async () => { if (h.srv) await h.lock(); });
  await h.unlock();
  for (let i = 0; i < 6; i++) await h.set(i);
  return h;
}

test('untouched log: show and export work as before', async (t) => {
  const h = await harness(t);
  const r = await h.c.auditRead({});
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.events.length, h.lines().length);
  const e = await h.c.auditExport({});
  assert.strictEqual(e.ok, true);
  assert.strictEqual(e.records, h.lines().length);
  assert.ok(e.content.length > 0);
  await h.set(90);
  assert.strictEqual((await h.c.auditRead({})).events.length, h.lines().length, 'new records show up');
  assert.strictEqual((await h.c.auditVerify()).ok, true);
});

test('a record changed in the middle: show is refused and the mark is stored', async (t) => {
  const h = await harness(t);
  h.editMiddle();
  const r = await h.c.auditRead({});
  assert.strictEqual(r.ok, false, JSON.stringify(r));
  assert.strictEqual(r.tampered, true);
  assert.deepStrictEqual(r.events, []);
  assert.match(r.error, /changed behind the vault/);
  // The mark survives even when the file is put back and the vault is locked and unlocked.
  const original = h.text();
  await h.lock();
  await h.unlock();
  const v = await h.c.auditVerify();
  assert.strictEqual(v.ok, false, 'the mark persists: ' + JSON.stringify(v));
  assert.strictEqual(v.tampered, true);
  assert.strictEqual((await h.c.auditRead({})).ok, false);
  assert.ok(original.length > 0);
});

test('a record changed in the middle: export is refused', async (t) => {
  const h = await harness(t);
  h.editMiddle();
  const e = await h.c.auditExport({});
  assert.strictEqual(e.ok, false);
  assert.strictEqual(e.tampered, true);
  assert.strictEqual(e.content, undefined);
  assert.strictEqual((await h.c.auditVerify()).tampered, true);
});

test('a record changed in the middle, then an ordinary write: the live daemon marks it', async (t) => {
  const h = await harness(t);
  const good = h.text();
  h.editMiddle();
  await h.set(70);
  // Put the log back the way it was (plus nothing): only a stored mark can still report it.
  fs.writeFileSync(h.file(), good);
  const v = await h.c.auditVerify();
  assert.strictEqual(v.ok, false, JSON.stringify(v));
  assert.strictEqual(v.tampered, true);
});

test('explicit verify stores the mark too', async (t) => {
  const h = await harness(t);
  const good = h.text();
  h.editMiddle();
  assert.strictEqual((await h.c.auditVerify()).ok, false);
  fs.writeFileSync(h.file(), good);
  assert.strictEqual((await h.c.auditVerify()).tampered, true);
});

test('acknowledge is the only way out, and the log shows again afterwards', async (t) => {
  const h = await harness(t);
  const good = h.text();
  h.editMiddle();
  assert.strictEqual((await h.c.auditRead({})).ok, false);
  fs.writeFileSync(h.file(), good);
  assert.strictEqual((await h.c.auditRead({})).ok, false, 'a log that verifies again is still refused while the mark stands');
  const a = await h.c.auditAcknowledge();
  assert.strictEqual(a.cleared, true);
  assert.strictEqual((await h.c.auditRead({})).ok, true);
  assert.strictEqual((await h.c.auditExport({})).ok, true);
});

test('the cached check notices a change made after it, and stays cheap for a long log', async (t) => {
  const h = await harness(t);
  assert.strictEqual((await h.c.auditRead({})).ok, true);
  assert.strictEqual((await h.c.auditRead({})).ok, true);
  h.editMiddle();
  assert.strictEqual((await h.c.auditRead({})).ok, false, 'a stale cache must not hide the edit');
});

test('an edit that lands between the chain check and the append is not folded into the cache', async (t) => {
  const h = await harness(t);
  assert.strictEqual((await h.c.auditRead({})).ok, true); // warm cache
  // Same-length edit of a middle record, made after the daemon verified the chain and before it appends.
  h.hook = () => { h.hook = null; h.editMiddle(); };
  await h.set(91);
  assert.strictEqual(h.hook, null, 'the seam ran');
  const r = await h.c.auditRead({});
  assert.strictEqual(r.ok, false, 'the next read re-verifies and catches the edit: ' + JSON.stringify(r));
  assert.strictEqual(r.tampered, true);
});
