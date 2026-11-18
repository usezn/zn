'use strict';
/*
 * A cut last line of the vault audit log (a write cut by a crash, a power loss
 * or a full disk) must never cost the secrets and never hide a change:
 * - locked: unlock refuses in words and names `zn unlock --repair-cut-audit-tail`;
 * - with that flag: the cut bytes move to audit.jsonl.cut-<time> (kept), a record
 *   with their hash and size is appended, the chain verifies, the secrets are there;
 * - a change before the last line as well: the repair is refused, the log stays,
 *   and the message names a way out that keeps the secrets before `zn vault reset`;
 * - unlocked: a write is refused with the same repair hint, not "internal error".
 * Runs the real daemon and client against a temporary ZN_HOME with fake secrets.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
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
  process.env.ZN_HOME = tempDir(t, 'zncut-');
  const created = await keychain.initIdentity({ passphrase: 'correct horse battery staple', workFactor: 10 });
  const identity = created.identity || created;
  const base = { identity, ttlMs: 60000, idleMs: 60000, confirm: async () => true };
  const h = { srv: null, c: null, values: {} };
  h.unlock = async (extra) => { h.srv = await daemon.serve(Object.assign({}, base, extra || {})); h.c = clientMod.createClient({}); return h.srv; };
  h.lock = async () => { h.c.close(); await h.srv.close(); h.srv = null; h.c = null; };
  h.file = () => store.paths().auditFile;
  h.bytes = () => fs.readFileSync(h.file());
  h.records = () => fs.readFileSync(h.file(), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  h.cutFiles = () => fs.readdirSync(path.dirname(h.file())).filter((f) => f.startsWith(path.basename(h.file()) + '.cut-'));
  h.set = async (name) => { h.values[name] = 'value-' + name + '-' + fake(12); await h.c.setSecret(name, h.values[name], { mode: 'env' }); };
  h.allThere = async () => { for (const [n, v] of Object.entries(h.values)) assert.strictEqual(await h.c.sameSecretValue(n, v), true, n); };
  t.after(async () => { if (h.srv) await h.lock(); });
  await h.unlock();
  for (let i = 0; i < 4; i++) await h.set('K' + i);
  return h;
}

/* Half of the next record, as a write stopped by a power loss or a full disk leaves it. That record was never
 * checkpointed: the daemon flushes a record before the vault remembers it. */
function cutLastLine(file) {
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  const last = JSON.parse(lines[lines.length - 1]);
  const next = JSON.stringify(Object.assign({}, last, { seq: last.seq + 1, prev: last.mac, reason: 'created', mac: 'f'.repeat(64) })) + '\n';
  const cut = Buffer.from(next.slice(0, Math.floor(next.length / 2)));
  fs.appendFileSync(file, cut);
  return cut;
}

/* Cut a record the vault had already checkpointed: no crash does that (the record is flushed first). */
function cutCheckpointedLine(file) {
  const buf = fs.readFileSync(file);
  const lastStart = buf.lastIndexOf(0x0a, buf.length - 2) + 1;
  fs.truncateSync(file, lastStart + Math.floor((buf.length - lastStart) / 2));
}

/* Change one field of a record in the middle (its MAC no longer matches). */
function tamperMiddle(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const i = Math.floor((lines.length - 1) / 2);
  const rec = JSON.parse(lines[i]);
  rec.reason = 'edited';
  lines[i] = JSON.stringify(rec);
  fs.writeFileSync(file, lines.join('\n'));
}

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

test('locked, last line cut: unlock refuses in words, names the repair, changes nothing', async (t) => {
  const h = await harness(t);
  await h.lock();
  cutLastLine(h.file());
  const before = h.bytes();
  await assert.rejects(h.unlock(), (e) => {
    assert.strictEqual(e.code, 'ZN_LOCKED');
    assert.strictEqual(e.cutTail, true);
    assert.match(e.message, /is cut or is not a record, and every record before it verifies/);
    assert.match(e.message, /zn unlock --repair-cut-audit-tail/);
    assert.match(e.message, /your secrets are safe/);
    assert.doesNotMatch(e.message, /vault reset/);
    return true;
  });
  h.srv = null;
  assert.deepStrictEqual(h.bytes(), before);
  assert.deepStrictEqual(h.cutFiles(), []);
});

test('locked, last line cut: --repair-cut-audit-tail keeps the bytes, records their hash, the chain verifies and no secret is lost', async (t) => {
  const h = await harness(t);
  await h.lock();
  const recordsBefore = h.records().length;
  const cut = cutLastLine(h.file());
  // A refused unlock first (it must not leave anything that blocks the repair).
  await assert.rejects(h.unlock());
  const srv = await h.unlock({ repairCutTail: true });
  const r = srv.repair;
  assert.strictEqual(r.repaired, true, JSON.stringify(r));
  assert.strictEqual(r.bytes, cut.length);
  assert.strictEqual(r.sha256, sha(cut));
  assert.strictEqual(r.line, recordsBefore + 1);
  assert.strictEqual(r.records, recordsBefore);
  // The refused unlock stored a warning for this very line; the repair record replaces it.
  assert.strictEqual(r.clearedWarning, true);
  const files = h.cutFiles();
  assert.strictEqual(files.length, 1);
  assert.strictEqual(path.join(path.dirname(h.file()), files[0]), r.path);
  assert.deepStrictEqual(fs.readFileSync(r.path), cut);
  const recs = h.records();
  const repairRec = recs.find((x) => typeof x.reason === 'string' && x.reason.startsWith('audit_tail_cut:'));
  assert.ok(repairRec, 'a repair record is in the log');
  assert.strictEqual(repairRec.reason, 'audit_tail_cut:' + sha(cut).slice(0, 32) + ':' + cut.length);
  assert.strictEqual(repairRec.decision, 'warn');
  assert.strictEqual(repairRec.seq, recordsBefore + 1);
  const v = await h.c.auditVerify();
  assert.strictEqual(v.ok, true, JSON.stringify(v));
  await h.allThere();
  // The chain goes on: new writes, a lock and an unlock all verify.
  await h.set('K9');
  await h.lock();
  await h.unlock();
  assert.strictEqual((await h.c.auditVerify()).ok, true);
  await h.allThere();
});

test('locked, garbage line appended: refused, then repaired the same way', async (t) => {
  const h = await harness(t);
  await h.lock();
  const garbage = Buffer.from('not a record at all\n');
  fs.appendFileSync(h.file(), garbage);
  await assert.rejects(h.unlock(), (e) => e.cutTail === true);
  h.srv = null;
  const srv = await h.unlock({ repairCutTail: true });
  assert.strictEqual(srv.repair.repaired, true);
  assert.strictEqual(srv.repair.sha256, sha(garbage));
  assert.deepStrictEqual(fs.readFileSync(srv.repair.path), garbage);
  assert.strictEqual((await h.c.auditVerify()).ok, true);
  await h.allThere();
});

test('cut last line plus a change in the middle: the repair is refused, the log is kept, the way out keeps the secrets', async (t) => {
  const h = await harness(t);
  await h.lock();
  tamperMiddle(h.file());
  cutLastLine(h.file());
  const before = h.bytes();
  for (const extra of [undefined, { repairCutTail: true }]) {
    await assert.rejects(h.unlock(extra), (e) => {
      assert.strictEqual(e.code, 'ZN_LOCKED');
      assert.notStrictEqual(e.cutTail, true);
      assert.match(e.message, /does not verify \(bad mac/);
      assert.match(e.message, /move ~\/\.zn\/audit\.jsonl to a safe place/);
      assert.match(e.message, /last resort/);
      assert.ok(e.message.indexOf('move ~/.zn/audit.jsonl') < e.message.indexOf('vault reset'));
      return true;
    });
    h.srv = null;
    assert.deepStrictEqual(h.bytes(), before);
    assert.deepStrictEqual(h.cutFiles(), []);
  }
  // The named way out: set the log aside, unlock. The secrets are there and the change stays reported.
  fs.renameSync(h.file(), h.file() + '.evidence');
  await h.unlock();
  await h.allThere();
  const v = await h.c.auditVerify();
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.tampered, true);
  assert.deepStrictEqual(fs.readFileSync(h.file() + '.evidence'), before);
});

test('unlocked, last line cut: a write is refused with the repair hint (not "internal error"); lock, repair, all secrets there', async (t) => {
  const h = await harness(t);
  cutLastLine(h.file());
  await assert.rejects(h.c.setSecret('K8', 'value-K8-' + fake(12), { mode: 'env' }), (e) => {
    assert.strictEqual(e.code, 'ZN_POLICY_DENIED');
    assert.doesNotMatch(e.message, /internal error/);
    assert.match(e.message, /last line of the audit log is cut/);
    assert.match(e.message, /zn lock, then zn unlock --repair-cut-audit-tail/);
    return true;
  });
  const v = await h.c.auditVerify();
  assert.strictEqual(v.ok, false);
  assert.match(String(v.repairHint), /zn unlock --repair-cut-audit-tail/);
  await assert.rejects(h.c.auditAcknowledge(), /--repair-cut-audit-tail/);
  await h.lock();
  const srv = await h.unlock({ repairCutTail: true });
  assert.strictEqual(srv.repair.repaired, true);
  // The warning the vault stored for this very cut line is replaced by the repair record.
  assert.strictEqual(srv.repair.clearedWarning, true);
  assert.strictEqual((await h.c.auditVerify()).ok, true);
  await h.allThere();
});

test('--repair-cut-audit-tail on an intact log: nothing to repair, nothing moved', async (t) => {
  const h = await harness(t);
  await h.lock();
  const srv = await h.unlock({ repairCutTail: true });
  assert.deepStrictEqual(srv.repair, { repaired: false });
  assert.deepStrictEqual(h.cutFiles(), []);
  assert.strictEqual(h.records().some((x) => String(x.reason).startsWith('audit_tail_cut')), false);
  assert.strictEqual((await h.c.auditVerify()).ok, true);
});

test('a cut record the vault had checkpointed is not a crash: refused, kept, no reset first', async (t) => {
  const h = await harness(t);
  await h.lock();
  cutCheckpointedLine(h.file());
  const before = h.bytes();
  await assert.rejects(h.unlock({ repairCutTail: true }), (e) => {
    assert.match(e.message, /does not verify \(log truncated/);
    assert.ok(e.message.indexOf('move ~/.zn/audit.jsonl') < e.message.indexOf('vault reset'));
    return true;
  });
  h.srv = null;
  assert.deepStrictEqual(h.bytes(), before);
  assert.deepStrictEqual(h.cutFiles(), []);
});

test('checkCutTail: a cut line after a log shorter than the checkpoint is not a crash', async (t) => {
  const h = await harness(t);
  await h.lock();
  const file = h.file();
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  // Drop two whole records, then add a cut line: the records before it verify, but the vault expects more.
  fs.writeFileSync(file, lines.slice(0, -2).join('\n') + '\n' + lines[lines.length - 1].slice(0, 20));
  const before = h.bytes();
  await assert.rejects(h.unlock({ repairCutTail: true }), (e) => /does not verify \(log truncated/.test(e.message));
  h.srv = null;
  assert.deepStrictEqual(h.bytes(), before);
  assert.deepStrictEqual(h.cutFiles(), []);
  assert.strictEqual(audit.tailLine(file).parsed, false);
});
