'use strict';
/*
 * What `zn vault verify` says when the audit log fails, and that a change to
 * the secrets is never kept without its audit record:
 * - audit.verify names the kind of failure and the 1-based line of the file
 *   (empty lines included), for every kind: cut line, bad MAC (an edit or a
 *   record from another vault), broken chain, sequence gap, checkpoint
 *   mismatch, truncation;
 * - the unlocked vault passes that reason and line on, and `zn vault verify`
 *   prints both without verbose mode;
 * - when the audit record of a set, a policy change, an approval, a removal or
 *   an adoption cannot be written, the change is undone: after lock and unlock
 *   the secrets are as before.
 * Fake keys and fake secret values only, in a temporary ZN_HOME.
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
const messages = require('../lib/messages');

const fake = (n) => crypto.randomBytes(n).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, n);
const KEY = Buffer.alloc(32, 7);
const OTHER_KEY = Buffer.alloc(32, 9);

/* A log of n records under KEY, as lines (no trailing newline). */
function makeLog(t, n) {
  const file = path.join(tempDir(t, 'znrep-'), 'audit.jsonl');
  for (let i = 0; i < n; i++) audit.append({ secret: 'K' + i, mode: 'set', decision: 'allow' }, { file, key: KEY });
  return { file, lines: fs.readFileSync(file, 'utf8').trim().split('\n') };
}

const write = (file, lines) => fs.writeFileSync(file, lines.join('\n') + '\n');
const remac = (rec, key) => { const r = Object.assign({}, rec); delete r.mac; r.mac = crypto.createHmac('sha256', key).update(JSON.stringify(r)).digest('hex'); return r; };

test('verify: an edited record is a bad MAC, named at its line of the file (an empty line counts)', (t) => {
  const { file, lines } = makeLog(t, 5);
  const rec = JSON.parse(lines[2]);
  rec.reason = 'edited';
  lines[2] = JSON.stringify(rec);
  write(file, [lines[0], '', lines[1], lines[2], lines[3], lines[4]]);
  const r = audit.verify({ file, key: KEY });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.kind, 'bad_mac');
  assert.strictEqual(r.line, 3); // third record
  assert.strictEqual(r.fileLine, 4); // fourth line of the file
  const d = audit.describeFailure(r);
  assert.match(d.reason, /does not carry a valid MAC: it was edited, or it was written with the key of another vault/);
  assert.strictEqual(d.fileLine, 4);
});

test('verify: a record from another vault (valid MAC under its own key) is a bad MAC', (t) => {
  const { file, lines } = makeLog(t, 4);
  lines[1] = JSON.stringify(remac(JSON.parse(lines[1]), OTHER_KEY));
  write(file, lines);
  const r = audit.verify({ file, key: KEY });
  assert.strictEqual(r.kind, 'bad_mac');
  assert.strictEqual(r.fileLine, 2);
});

test('verify: a removed record breaks the chain at the line after the gap', (t) => {
  const { file, lines } = makeLog(t, 5);
  write(file, [lines[0], lines[1], lines[3], lines[4]]);
  const r = audit.verify({ file, key: KEY });
  assert.strictEqual(r.kind, 'broken_chain');
  assert.strictEqual(r.fileLine, 3);
  assert.match(audit.describeFailure(r).reason, /does not link to the record before it/);
});

test('verify: a sequence gap with a valid chain is named as such', (t) => {
  const { file, lines } = makeLog(t, 4);
  // Record 3 renumbered to 7 and re-MACed with the real key; record 4 relinked to it.
  const r3 = remac(Object.assign(JSON.parse(lines[2]), { seq: 7 }), KEY);
  const r4 = remac(Object.assign(JSON.parse(lines[3]), { prev: r3.mac }), KEY);
  write(file, [lines[0], lines[1], JSON.stringify(r3), JSON.stringify(r4)]);
  const r = audit.verify({ file, key: KEY });
  assert.strictEqual(r.kind, 'sequence_gap');
  assert.strictEqual(r.fileLine, 3);
  assert.match(audit.describeFailure(r).reason, /wrong sequence number: records are missing or repeated/);
});

test('verify: a cut last line is named, with its line', (t) => {
  const { file, lines } = makeLog(t, 3);
  fs.writeFileSync(file, lines.join('\n') + '\n' + lines[2].slice(0, 30));
  const r = audit.verify({ file, key: KEY });
  assert.strictEqual(r.kind, 'cut');
  assert.strictEqual(r.fileLine, 4);
  assert.match(audit.describeFailure(r).reason, /cut or is not a record/);
});

test('verify: a record that differs from the checkpoint is named', (t) => {
  const { file, lines } = makeLog(t, 3);
  const r = audit.verify({ file, key: KEY, checkpoint: { seq: 2, mac: 'a'.repeat(64) } });
  assert.strictEqual(r.kind, 'checkpoint');
  assert.strictEqual(r.fileLine, 2);
  assert.match(audit.describeFailure(r).reason, /differs from the checkpoint the vault saved/);
  assert.ok(lines.length === 3);
});

test('verify: a truncated log names the line it ends at and how many records the vault expects', (t) => {
  const { file, lines } = makeLog(t, 6);
  const last = JSON.parse(lines[5]);
  write(file, lines.slice(0, 4));
  const r = audit.verify({ file, key: KEY, checkpoint: { seq: last.seq, mac: last.mac } });
  assert.strictEqual(r.kind, 'truncated');
  const d = audit.describeFailure(r);
  assert.strictEqual(d.reason, 'the log is shorter than the vault remembers: it ends at line 4 with 4 records, the vault expects 6');
  assert.strictEqual(d.fileLine, 4);
  fs.rmSync(file);
  const gone = audit.describeFailure(audit.verify({ file, key: KEY, checkpoint: { seq: last.seq, mac: last.mac } }));
  assert.strictEqual(gone.reason, 'the log is shorter than the vault remembers: it is empty or missing, the vault expects 6');
  assert.strictEqual(gone.fileLine, null);
});

test('the verify message always names the reason and the line, and keeps the evidence advice', () => {
  const quiet = {};
  const text = messages.auditCheckFailed('the record does not link to the record before it', 7, 'broken chain (record 6)', quiet);
  assert.strictEqual(text, 'The audit log did not pass its check: the record does not link to the record before it (line 7 of ~/.zn/audit.jsonl). ' +
    'Do not delete or edit it: it is the proof of what happened. More: ' + messages.TROUBLESHOOTING_URL);
  assert.ok(messages.auditCheckFailed('x', null, 'detail', { ZN_VERBOSE: '1' }).endsWith(' Detail: detail.'));
  assert.doesNotMatch(messages.auditCheckFailed('x', null, undefined, quiet), /line/);
});

/* ------------------------- the real daemon ------------------------- */

async function harness(t) {
  process.env.ZN_HOME = tempDir(t, 'znrepd-');
  const created = await keychain.initIdentity({ passphrase: 'correct horse battery staple', workFactor: 10 });
  const identity = created.identity || created;
  const base = { identity, ttlMs: 60000, idleMs: 60000, confirm: async () => true };
  const h = { srv: null, c: null, values: {} };
  h.unlock = async (extra) => { h.srv = await daemon.serve(Object.assign({}, base, extra || {})); h.c = clientMod.createClient({}); return h.srv; };
  h.lock = async () => { h.c.close(); await h.srv.close(); h.srv = null; h.c = null; };
  h.file = () => store.paths().auditFile;
  h.lines = () => fs.readFileSync(h.file(), 'utf8').trim().split('\n');
  h.set = async (name) => { h.values[name] = 'value-' + name + '-' + fake(12); await h.c.setSecret(name, h.values[name], { mode: 'env' }); };
  h.allThere = async () => { for (const [n, v] of Object.entries(h.values)) assert.strictEqual(await h.c.sameSecretValue(n, v), true, n); };
  h.names = async () => (await h.c.listSecrets()).map((s) => s.name).sort();
  t.after(async () => { if (h.srv) await h.lock(); });
  await h.unlock();
  for (let i = 0; i < 4; i++) await h.set('K' + i);
  return h;
}

/* Runs `zn vault verify` in this process (the in-process daemon answers) and returns {code, stderr}. */
async function runVerify() {
  const { runVaultCommand } = require('../lib/vault/cli');
  let stderr = '';
  const ew = process.stderr.write;
  process.stderr.write = (s) => { stderr += s; return true; };
  let code;
  try { code = await runVaultCommand(['vault', 'verify']); } finally { process.stderr.write = ew; }
  return { code, stderr };
}

test('zn vault verify on an edited record: reason and file line without verbose mode', async (t) => {
  const h = await harness(t);
  await h.lock();
  const lines = h.lines();
  const rec = JSON.parse(lines[2]);
  rec.reason = 'edited';
  lines[2] = JSON.stringify(rec);
  write(h.file(), lines);
  await h.unlock();
  const v = await h.c.auditVerify();
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.fileLine, 3);
  assert.match(v.why, /valid MAC/);
  delete process.env.ZN_VERBOSE;
  const r = await runVerify();
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /did not pass its check: the record does not carry a valid MAC: it was edited, or it was written with the key of another vault \(line 3 of ~\/\.zn\/audit\.jsonl\)/);
  assert.doesNotMatch(r.stderr, /at record/);
  assert.match(r.stderr, /vault verify --acknowledge/);
});

test('zn vault verify on a log cut by two records: says it is shorter and where it ends, not "at record N"', async (t) => {
  const h = await harness(t);
  await h.lock();
  const lines = h.lines();
  write(h.file(), lines.slice(0, -2));
  await h.unlock();
  const r = await runVerify();
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /the log is shorter than the vault remembers: it ends at line \d+ with \d+ records, the vault expects \d+|the last record of the log/);
  assert.doesNotMatch(r.stderr, /at record/);
});

/* Make every append to the audit log fail with an IO error while fn runs (a full or failing disk). */
async function withFailingAppend(file, fn) {
  const orig = fs.openSync;
  fs.openSync = function (p, flags, ...rest) {
    if (String(p) === file && flags === 'a') { const e = new Error('EIO: fake i/o error, write'); e.code = 'EIO'; throw e; }
    return orig.call(this, p, flags, ...rest);
  };
  try { return await fn(); } finally { fs.openSync = orig; }
}

test('an audit record that cannot be written undoes the change: set, update, remove, policy change; after lock and unlock nothing changed', async (t) => {
  const h = await harness(t);
  const linesBefore = h.lines().length;
  const namesBefore = await h.names();
  const policyBefore = (await h.c.listSecrets()).find((s) => s.name === 'K2');
  await withFailingAppend(h.file(), async () => {
    await assert.rejects(h.c.setSecret('K0', 'value-new-' + fake(16), { mode: 'env' }));
    await assert.rejects(h.c.setSecret('NEW_ONE', 'value-new-' + fake(16), { mode: 'env' }));
    await assert.rejects(h.c.removeSecret('K1'));
    // A policy change (the vault's confirmation answers yes here) writes a record too.
    await assert.rejects(h.c.updateSecretMeta('K2', { mode: 'proxy' }));
  });
  // Still unlocked: memory holds the old state.
  assert.deepStrictEqual(await h.names(), namesBefore);
  await h.allThere();
  assert.deepStrictEqual((await h.c.listSecrets()).find((s) => s.name === 'K2'), policyBefore);
  // Locked and unlocked again: the saved vault is the old one, and the log verifies.
  await h.lock();
  await h.unlock();
  assert.deepStrictEqual(await h.names(), namesBefore);
  await h.allThere();
  assert.deepStrictEqual((await h.c.listSecrets()).find((s) => s.name === 'K2'), policyBefore);
  assert.strictEqual((await h.c.auditVerify()).ok, true);
  // Nothing was written by the failed calls: the log grew only by lock, unlock and the reads above.
  assert.ok(h.lines().every((l) => !/NEW_ONE/.test(l)));
  assert.ok(h.lines().length > linesBefore);
});

test('a refused write after a cut last line does not keep the new secret either', async (t) => {
  const h = await harness(t);
  const lines = h.lines();
  fs.appendFileSync(h.file(), lines[lines.length - 1].slice(0, 25));
  await assert.rejects(h.c.setSecret('NEW_TWO', 'value-new-' + fake(16), { mode: 'env' }), /audit log is cut/);
  assert.ok(!(await h.names()).includes('NEW_TWO'));
  await h.lock();
  const srv = await h.unlock({ repairCutTail: true });
  assert.strictEqual(srv.repair.repaired, true);
  assert.ok(!(await h.names()).includes('NEW_TWO'));
  await h.allThere();
});
