'use strict';
/*
 * The vault compares the audit log with the checkpoint it keeps before it
 * appends anything. A log cut or replaced behind the daemon (while it is
 * locked or while it runs) is reported by `zn vault verify`, the warning
 * survives lock and unlock, and only the user can accept the log again.
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
const audit = require('../lib/vault/audit');

const fake = (n) => crypto.randomBytes(n).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, n);

async function harness(t) {
  process.env.ZN_HOME = tempDir(t, 'znrc-');
  const created = await keychain.initIdentity({ passphrase: 'correct horse battery staple', workFactor: 10 });
  const identity = created.identity || created;
  const answers = [];
  let answer = true;
  const opts = { identity, ttlMs: 60000, idleMs: 60000, confirm: async (req) => { answers.push(req); return answer; } };
  const h = { srv: null, c: null, answers, setAnswer: (v) => { answer = v; } };
  h.unlock = async () => { h.srv = await daemon.serve(opts); h.c = clientMod.createClient({}); };
  h.lock = async () => { h.c.close(); await h.srv.close(); h.srv = null; h.c = null; };
  h.file = () => store.paths().auditFile;
  h.lines = () => fs.readFileSync(h.file(), 'utf8').trim().split('\n');
  h.cut = (n) => { const l = h.lines(); fs.writeFileSync(h.file(), l.slice(0, l.length - n).join('\n') + '\n'); };
  h.set = (i) => h.c.setSecret('K' + i, 'value-' + i + '-' + fake(10), { mode: 'env' });
  t.after(async () => { if (h.srv) await h.lock(); });
  await h.unlock();
  return h;
}

test('normal use stays ok: many writes, lock and unlock cycles, a growing log', async (t) => {
  const h = await harness(t);
  for (let cycle = 0; cycle < 3; cycle++) {
    for (let i = 0; i < 8; i++) await h.set(cycle * 8 + i);
    const r = await h.c.auditVerify();
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    await h.lock();
    await h.unlock();
    const r2 = await h.c.auditVerify();
    assert.strictEqual(r2.ok, true, JSON.stringify(r2));
  }
  const last = h.lines().length;
  assert.ok(last > 24);
  assert.strictEqual((await h.c.auditVerify()).records, last);
});

test('locked: a cut tail is reported after the next unlock, and the warning survives more lock and unlock cycles', async (t) => {
  const h = await harness(t);
  for (let i = 0; i < 4; i++) await h.set(i);
  await h.lock();
  h.cut(3);
  await h.unlock();
  const r = await h.c.auditVerify();
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.tampered, true);
  assert.match(r.error, /changed behind the vault/);
  assert.match(r.error, /truncated/);
  for (let i = 0; i < 2; i++) {
    await h.set(10 + i);
    await h.lock();
    await h.unlock();
    const again = await h.c.auditVerify();
    assert.strictEqual(again.ok, false, 'the mark persists: ' + JSON.stringify(again));
    assert.strictEqual(again.tampered, true);
  }
});

test('unlocked: a cut tail followed by an ordinary audit event is still reported, and the mark persists', async (t) => {
  const h = await harness(t);
  for (let i = 0; i < 4; i++) await h.set(i);
  assert.strictEqual((await h.c.auditVerify()).ok, true);
  h.cut(2);
  await h.set(20);
  const r = await h.c.auditVerify();
  assert.strictEqual(r.ok, false, JSON.stringify(r));
  assert.strictEqual(r.tampered, true);
  await h.set(21);
  assert.strictEqual((await h.c.auditVerify()).ok, false);
  await h.lock();
  await h.unlock();
  assert.strictEqual((await h.c.auditVerify()).ok, false, 'still reported after lock and unlock');
});

test('a cut followed by enough new records to reach the old length is reported by MAC', async (t) => {
  const h = await harness(t);
  for (let i = 0; i < 3; i++) await h.set(i);
  const before = h.lines().length;
  h.cut(2);
  for (let i = 0; i < 6; i++) await h.set(30 + i);
  assert.ok(h.lines().length >= before);
  const r = await h.c.auditVerify();
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.tampered, true);
});

test('the checkpoint is not moved to a forged tail', async (t) => {
  const h = await harness(t);
  for (let i = 0; i < 4; i++) await h.set(i);
  const head = h.lines().length;
  h.cut(2);
  await h.set(40);
  await h.lock();
  // The vault still expects the original last record, whatever the log now ends with.
  await h.unlock();
  const r = await h.c.auditVerify();
  assert.strictEqual(r.ok, false);
  assert.match(r.error, new RegExp('expects ' + head + ' records|not the one|differs'));
});

test('acknowledge: only after confirmation, it accepts the log as it is and leaves a warning record', async (t) => {
  const h = await harness(t);
  for (let i = 0; i < 4; i++) await h.set(i);
  h.cut(2);
  await h.set(50);
  assert.strictEqual((await h.c.auditVerify()).ok, false);
  h.setAnswer(false);
  await assert.rejects(() => h.c.auditAcknowledge(), /declined/);
  assert.strictEqual((await h.c.auditVerify()).ok, false, 'a refused confirmation changes nothing');
  h.setAnswer(true);
  const a = await h.c.auditAcknowledge();
  assert.strictEqual(a.cleared, true);
  assert.ok(h.answers.some((q) => q.kind === 'audit_ack'));
  const ok = await h.c.auditVerify();
  assert.strictEqual(ok.ok, true, JSON.stringify(ok));
  assert.ok(h.lines().some((l) => JSON.parse(l).reason === 'audit_tamper_acknowledged'));
  await h.set(51);
  await h.lock();
  await h.unlock();
  assert.strictEqual((await h.c.auditVerify()).ok, true, 'and the vault is healthy again after a lock cycle');
  assert.deepStrictEqual(await h.c.auditAcknowledge(), { ok: true, cleared: false });
});

test('acknowledge refuses when the chain itself is broken', async (t) => {
  const h = await harness(t);
  for (let i = 0; i < 4; i++) await h.set(i);
  h.cut(1);
  await h.set(60);
  const lines = h.lines();
  const rec = JSON.parse(lines[1]);
  rec.decision = 'deny';
  lines[1] = JSON.stringify(rec);
  fs.writeFileSync(h.file(), lines.join('\n') + '\n');
  await assert.rejects(() => h.c.auditAcknowledge(), /does not verify on its own/);
  assert.strictEqual((await h.c.auditVerify()).ok, false);
});

test('a log that cannot be read at its end is reported, not skipped', async (t) => {
  const h = await harness(t);
  for (let i = 0; i < 2; i++) await h.set(i);
  await h.lock();
  fs.appendFileSync(h.file(), '{"not json\n');
  await assert.rejects(() => h.unlock(), /cannot be read/);
  assert.strictEqual(h.srv, null);
  // The warning is stored: once the tail is readable again (here: the bad line removed), verify still reports it.
  fs.writeFileSync(h.file(), h.lines().slice(0, -1).join('\n') + '\n');
  await h.unlock();
  const r = await h.c.auditVerify();
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.tampered, true);
});

test('audit.checkHead compares the last record by sequence number and MAC', (t) => {
  const dir = tempDir(t, 'znrc-ch-');
  const file = dir + '/audit.jsonl';
  const key = crypto.randomBytes(32);
  assert.strictEqual(audit.checkHead(file, null).ok, true);
  const a = audit.append({ mode: 'env', decision: 'allow' }, { file, key });
  const b = audit.append({ mode: 'env', decision: 'allow' }, { file, key });
  assert.strictEqual(audit.checkHead(file, { seq: b.seq, mac: b.mac }).ok, true);
  assert.strictEqual(audit.checkHead(file, { seq: a.seq, mac: a.mac }).ok, false);
  assert.strictEqual(audit.checkHead(file, { seq: b.seq }).ok, false, 'a head without a MAC fails closed');
  fs.unlinkSync(file);
  assert.strictEqual(audit.checkHead(file, { seq: b.seq, mac: b.mac }).ok, false);
});
