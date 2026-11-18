'use strict';
/*
 * Every vault file carries a format version `v`. A missing one counts as 1; a newer one (written by a later zn-gate)
 * is refused with a message that says to update and never to reset, and the file is never rewritten.
 * Runs the real daemon against a temporary ZN_HOME. Fake values only.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { tempDir } = require('./helpers/tmp');

process.env.ZN_KEYCHAIN_BACKEND = 'passphrase';
const keychain = require('../lib/vault/keychain');
const daemon = require('../lib/vault/daemon');
const clientMod = require('../lib/vault/client');
const store = require('../lib/vault/store');
const audit = require('../lib/vault/audit');

const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const NEWER = (e) => e.code === 'ZN_LOCKED' && /newer zn-gate \(format 2/.test(e.message) &&
  /Update zn-gate: `npm install -g zn-gate@latest`/.test(e.message) && /secrets are not lost/.test(e.message) && !/vault reset/.test(e.message);

async function harness(t) {
  process.env.ZN_HOME = tempDir(t, 'znvf-');
  const created = await keychain.initIdentity({ passphrase: 'correct horse battery staple', workFactor: 10 });
  const identity = created.identity || created;
  const meta = keychain.readMeta({});
  const h = { identity, meta, srv: null, c: null };
  const opts = { identity, ttlMs: 60000, idleMs: 60000, confirm: async () => true };
  h.unlock = async () => { h.srv = await daemon.serve(opts); h.c = clientMod.createClient({}); };
  h.lock = async () => { if (h.c) h.c.close(); if (h.srv) await h.srv.close(); h.srv = null; h.c = null; };
  // Rewrite an encrypted file with a different `v` (and a fresh valid mac for secrets.age).
  const originals = new Map();
  h.rewrite = async (file, v, withMac) => {
    if (!originals.has(file)) originals.set(file, await store.readEncrypted(file, identity));
    const doc = JSON.parse(JSON.stringify(originals.get(file)));
    if (v === undefined) delete doc.v; else doc.v = v;
    if (withMac) {
      delete doc.mac;
      const k = crypto.createHmac('sha256', String(identity)).update('zn-vault-integrity-v1').digest();
      doc.mac = crypto.createHmac('sha256', k).update(JSON.stringify(doc)).digest('hex');
    }
    await store.writeEncrypted(file, doc, meta.recipient);
  };
  t.after(async () => { await h.lock(); });
  await h.unlock();
  await h.c.setSecret('EXAMPLE_KEY', 'fake-value-0000', { mode: 'env' });
  await h.c.mapToken('/work/app', 'EMAIL', 'bob@example.com');
  await h.lock();
  return h;
}

test('secrets.age with v:2 and a valid mac is refused and left untouched; v missing loads as 1; v:1 unchanged', async (t) => {
  const h = await harness(t);
  const p = store.paths();
  await h.rewrite(p.secretsFile, 2, true);
  const before = sha(p.secretsFile);
  await assert.rejects(h.unlock(), NEWER);
  assert.strictEqual(sha(p.secretsFile), before, 'the newer file was not rewritten');
  // No v at all: an older file, still read as version 1.
  await h.rewrite(p.secretsFile, undefined, true);
  await h.unlock();
  assert.deepStrictEqual((await h.c.listSecrets()).map((s) => s.name), ['EXAMPLE_KEY']);
  await h.lock();
  // v:1 as written today.
  await h.rewrite(p.secretsFile, 1, true);
  await h.unlock();
  assert.deepStrictEqual((await h.c.listSecrets()).map((s) => s.name), ['EXAMPLE_KEY']);
});

test('a project map with v:2 is refused on use and never rewritten', async (t) => {
  const h = await harness(t);
  const file = store.projectFile('/work/app');
  await h.rewrite(file, 2, false);
  const before = sha(file);
  await h.unlock();
  await assert.rejects(h.c.mapToken('/work/app', 'EMAIL', 'alice@example.com'), NEWER);
  await assert.rejects(h.c.mapToken('/work/app', 'EMAIL', 'bob@example.com'), NEWER);
  await h.lock();
  assert.strictEqual(sha(file), before);
  await h.rewrite(file, undefined, false);
  await h.unlock();
  assert.strictEqual(await h.c.mapToken('/work/app', 'EMAIL', 'bob@example.com'), '__ZN_EMAIL_1__');
});

test('keychain.json with v:2 is refused and left untouched; without v it loads', async (t) => {
  const h = await harness(t);
  const p = store.paths();
  const raw = fs.readFileSync(p.metaFile, 'utf8');
  const meta = JSON.parse(raw);
  fs.writeFileSync(p.metaFile, JSON.stringify(Object.assign({}, meta, { v: 2 })));
  const before = sha(p.metaFile);
  assert.throws(() => keychain.readMeta({}), NEWER);
  await assert.rejects(h.unlock(), NEWER);
  assert.strictEqual(sha(p.metaFile), before);
  delete meta.v;
  fs.writeFileSync(p.metaFile, JSON.stringify(meta));
  assert.strictEqual(keychain.readMeta({}).backend, 'passphrase');
});

test('an audit record with v:2 refuses verify and append, is not called tampering, and the log is untouched', async (t) => {
  const dir = tempDir(t, 'znvf-audit-');
  const file = path.join(dir, 'audit.jsonl');
  const key = crypto.randomBytes(32);
  audit.append({ secret: 'EXAMPLE_KEY', mode: 'env', decision: 'allow' }, { file, key });
  const rec = JSON.parse(fs.readFileSync(file, 'utf8').trim());
  assert.strictEqual(rec.v, 1);
  assert.deepStrictEqual(audit.verify({ file, key }), { ok: true, records: 1 });
  // Version missing: still read as 1 (the mac covers the record as written).
  const next = { v: 2, seq: 2, ts: new Date().toISOString(), secret: 'EXAMPLE_KEY', mode: 'env', decision: 'allow', prev: rec.mac };
  next.mac = crypto.createHmac('sha256', key).update(JSON.stringify(next)).digest('hex');
  fs.appendFileSync(file, JSON.stringify(next) + '\n');
  const before = sha(file);
  assert.throws(() => audit.verify({ file, key }), NEWER);
  assert.throws(() => audit.append({ secret: 'EXAMPLE_KEY', mode: 'env', decision: 'deny' }, { file, key }), NEWER);
  assert.strictEqual(sha(file), before);
});

test('the daemon reports a newer audit record as a read problem with the update message, not as tampering', async (t) => {
  const h = await harness(t);
  const p = store.paths();
  const lines = fs.readFileSync(p.auditFile, 'utf8').trim().split('\n');
  const last = JSON.parse(lines[lines.length - 1]);
  assert.strictEqual(last.v, 1);
  const secrets = await store.readEncrypted(p.secretsFile, h.identity);
  const next = { v: 2, seq: last.seq + 1, ts: new Date().toISOString(), secret: 'EXAMPLE_KEY', mode: 'env', decision: 'allow', prev: last.mac };
  next.mac = crypto.createHmac('sha256', Buffer.from(secrets.auditKey, 'hex')).update(JSON.stringify(next)).digest('hex');
  fs.appendFileSync(p.auditFile, JSON.stringify(next) + '\n');
  const before = sha(p.auditFile);
  await assert.rejects(h.unlock(), NEWER);
  assert.strictEqual(sha(p.auditFile), before, 'nothing was appended after the newer record');
  const after = await store.readEncrypted(p.secretsFile, h.identity);
  assert.ok(!after.auditTamper, "no tamper mark was stored");
});
