'use strict';
/**
 * First-use approvals follow the value they were granted for: removing a
 * secret drops its approvals, and replacing its value (set over an existing
 * one) asks again. An approval recorded before generations existed counts as
 * not approved. Fake values only; the vault runs against a temporary ZN_HOME.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'zngen-'));
process.env.ZN_HOME = HOME;
process.env.ZN_KEYCHAIN_BACKEND = 'passphrase';

const store = require('../lib/vault/store');
const keychain = require('../lib/vault/keychain');
const daemon = require('../lib/vault/daemon');
const clientMod = require('../lib/vault/client');

const PROJECT = '/work/app';
const fake = () => 'fake-' + crypto.randomBytes(12).toString('hex');
const asked = [];
let srv = null;
let identity = null;
let duringConfirm = null;

async function start() {
  srv = await daemon.serve({ identity, ttlMs: 60000, idleMs: 60000, confirm: async (req) => { asked.push(req); if (duringConfirm) await duringConfirm(req); return true; } });
}
async function stop() {
  if (srv) { await srv.close(); srv = null; }
}
async function secretsFile() {
  return store.readEncrypted(store.paths().secretsFile, identity);
}
const approvalPrompts = () => asked.filter((r) => r.kind === 'approval').length;

test.before(async () => {
  const created = await keychain.initIdentity({ passphrase: 'correct horse battery staple', workFactor: 10 });
  identity = created.identity;
  assert.ok(clientMod.resolveExecutable('node'), 'node must be on PATH for these tests');
  await start();
});
test.after(async () => {
  await stop();
  fs.rmSync(HOME, { recursive: true, force: true });
});

const meta = { mode: 'env', allowCommands: ['node'] };

test('removing a secret and storing a new value under the same name asks again', async () => {
  const c = clientMod.createClient({});
  await c.setSecret('DEMO_RM_KEY', fake(), meta);
  await c.recordApproval(PROJECT, 'DEMO_RM_KEY', 'node');
  assert.equal(await c.isApproved(PROJECT, 'DEMO_RM_KEY', 'node'), true);
  assert.equal(await c.removeSecret('DEMO_RM_KEY'), true);
  const afterRm = await secretsFile();
  assert.ok(!Object.keys(afterRm.approvals || {}).some((k) => k.split(':')[1] === 'DEMO_RM_KEY'), 'rm drops the approvals of that secret');
  await c.setSecret('DEMO_RM_KEY', fake(), meta);
  assert.equal(await c.isApproved(PROJECT, 'DEMO_RM_KEY', 'node'), false, 'the new value does not inherit the approval');
  const before = approvalPrompts();
  await c.recordApproval(PROJECT, 'DEMO_RM_KEY', 'node');
  assert.equal(approvalPrompts(), before + 1, 'the user is asked again');
  assert.equal(await c.isApproved(PROJECT, 'DEMO_RM_KEY', 'node'), true);
  c.close();
});

test('replacing a value without removing it asks again; the same value and a policy change do not', async () => {
  const c = clientMod.createClient({});
  const value = fake();
  await c.setSecret('DEMO_SET_KEY', value, meta);
  await c.recordApproval(PROJECT, 'DEMO_SET_KEY', 'node');
  assert.equal(await c.isApproved(PROJECT, 'DEMO_SET_KEY', 'node'), true);
  await c.setSecret('DEMO_SET_KEY', value, meta);
  assert.equal(await c.isApproved(PROJECT, 'DEMO_SET_KEY', 'node'), true, 'the same value is the same secret');
  await c.updateSecretMeta('DEMO_SET_KEY', { allowHosts: ['api.example.com'] });
  assert.equal(await c.isApproved(PROJECT, 'DEMO_SET_KEY', 'node'), true, 'a policy change keeps the generation');
  await c.setSecret('DEMO_SET_KEY', fake(), meta);
  assert.equal(await c.isApproved(PROJECT, 'DEMO_SET_KEY', 'node'), false, 'a replaced value is not approved');
  const before = approvalPrompts();
  await c.recordApproval(PROJECT, 'DEMO_SET_KEY', 'node');
  assert.equal(approvalPrompts(), before + 1);
  assert.equal(await c.isApproved(PROJECT, 'DEMO_SET_KEY', 'node'), true);
  c.close();
});

test('removing or replacing one secret leaves the approvals of another untouched', async () => {
  const c = clientMod.createClient({});
  await c.setSecret('DEMO_KEEP_KEY', fake(), meta);
  await c.setSecret('DEMO_GONE_KEY', fake(), meta);
  await c.recordApproval(PROJECT, 'DEMO_KEEP_KEY', 'node');
  await c.recordApproval('/work/other', 'DEMO_KEEP_KEY', 'node');
  await c.recordApproval(PROJECT, 'DEMO_GONE_KEY', 'node');
  await c.removeSecret('DEMO_GONE_KEY');
  await c.setSecret('DEMO_GONE_KEY', fake(), meta);
  assert.equal(await c.isApproved(PROJECT, 'DEMO_KEEP_KEY', 'node'), true);
  assert.equal(await c.isApproved('/work/other', 'DEMO_KEEP_KEY', 'node'), true);
  assert.equal(await c.isApproved(PROJECT, 'DEMO_GONE_KEY', 'node'), false);
  c.close();
});

test('an approval recorded without a generation id is not approved, and approving again fixes it', async () => {
  await stop();
  // A vault as an earlier version wrote it: no generation on the secret, none on the approval.
  const data = await secretsFile();
  const legacyKey = Object.keys(data.approvals).find((k) => k.split(':')[1] === 'DEMO_KEEP_KEY');
  assert.ok(legacyKey);
  const rec = data.approvals[legacyKey];
  delete data.secrets.DEMO_KEEP_KEY.generation;
  data.approvals[legacyKey] = { ts: rec.ts, exe: rec.exe, fp: rec.fp };
  const hmacKey = crypto.createHmac('sha256', String(identity)).update('zn-vault-integrity-v1').digest();
  delete data.mac;
  data.mac = crypto.createHmac('sha256', hmacKey).update(JSON.stringify(data)).digest('hex');
  await store.writeEncrypted(store.paths().secretsFile, data, keychain.readMeta({}).recipient);
  await start();
  const c = clientMod.createClient({});
  assert.equal(await c.isApproved(PROJECT, 'DEMO_KEEP_KEY', 'node'), false, 'an old approval is asked for once more');
  const before = approvalPrompts();
  await c.recordApproval(PROJECT, 'DEMO_KEEP_KEY', 'node');
  assert.equal(approvalPrompts(), before + 1);
  assert.equal(await c.isApproved(PROJECT, 'DEMO_KEEP_KEY', 'node'), true);
  const now = await secretsFile();
  assert.match(now.secrets.DEMO_KEEP_KEY.generation, /^[0-9a-f]{32}$/);
  assert.equal(now.approvals[legacyKey].gen, now.secrets.DEMO_KEEP_KEY.generation);
  c.close();
});

test('replacing a secret while its first-use confirmation is pending refuses the approval and records nothing', async () => {
  const c = clientMod.createClient({});
  const other = clientMod.createClient({});
  await c.setSecret('DEMO_PENDING_KEY', fake(), meta);
  let replaced = false;
  duringConfirm = async (req) => {
    if (req.kind !== 'approval' || replaced) return;
    replaced = true;
    await other.setSecret('DEMO_PENDING_KEY', fake(), meta);
  };
  try {
    await assert.rejects(c.recordApproval(PROJECT, 'DEMO_PENDING_KEY', 'node'), (e) => e.code === 'ZN_POLICY_DENIED' && /changed while waiting for confirmation/.test(e.message));
  } finally {
    duringConfirm = null;
  }
  assert.ok(replaced, 'the value was replaced while the dialog was open');
  assert.equal(await c.isApproved(PROJECT, 'DEMO_PENDING_KEY', 'node'), false);
  const data = await secretsFile();
  assert.ok(!Object.keys(data.approvals || {}).some((k) => k.split(':')[1] === 'DEMO_PENDING_KEY'), 'nothing was recorded');
  // Asking again, with no change during the prompt, works.
  await c.recordApproval(PROJECT, 'DEMO_PENDING_KEY', 'node');
  assert.equal(await c.isApproved(PROJECT, 'DEMO_PENDING_KEY', 'node'), true);
  c.close();
  other.close();
});
