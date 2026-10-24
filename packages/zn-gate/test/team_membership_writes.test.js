'use strict';
/*
 * Membership generation, every write: a sync that started before `zn team
 * leave`, or before a join of another organization, cannot write anything
 * afterwards. Besides the policy answer and the upload state (see
 * team_membership_generation.test.js) this covers the policy write itself, the
 * last-sync record, the upload lock, the readable copies put back by status
 * and by the hook, and a lock that a newer upload created.
 *
 * The race is made exact: a hook runs just before the Nth serialised section
 * of the vault starts, which is where the leave or the join would have got in.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-team-gen-writes-'));
process.env.ZN_HOME = path.join(HOME, '.zn');

const { startFakeTeamServer, makeAuditChain } = require('./helpers/fake_team_server');
const { makeTeamOps } = require('../lib/team/daemon-ops');
const { uploadPending } = require('../lib/team/upload');
const policy = require('../lib/team/policy');
const { syncOutcome } = require('../lib/team/sync-outcome');

const AUDIT_KEY = 'ab'.repeat(32);
let cloud;

test.before(async () => { cloud = await startFakeTeamServer(); });
test.after(async () => { await cloud.close(); fs.rmSync(HOME, { recursive: true, force: true }); });
test.beforeEach(() => {
  cloud.setOrgActive(true);
  fs.rmSync(process.env.ZN_HOME, { recursive: true, force: true });
  fs.mkdirSync(process.env.ZN_HOME, { recursive: true });
});

function machine() {
  const audit = [];
  const secrets = { auditKey: AUDIT_KEY, secrets: {} };
  const auditFile = path.join(process.env.ZN_HOME, 'audit.jsonl');
  const gate = { count: 0, at: 0, fn: null, fired: false };
  const state = {
    opts: { home: process.env.ZN_HOME },
    paths: { auditFile },
    loadSecrets: async () => secrets,
    saveSecrets: async () => {},
    serial: async (fn) => {
      gate.count += 1;
      if (gate.fn && gate.count === gate.at) { const f = gate.fn; gate.fn = null; gate.fired = true; await f(); }
      return fn();
    },
  };
  const o = makeTeamOps({ state, fetchImpl: fetch, writeAudit: (r) => audit.push(r), confirmOutOfBand: async () => {} });
  /* Runs fn just before the nth serialised section from now. */
  const before = (n, fn) => { gate.count = 0; gate.at = n; gate.fn = fn; gate.fired = false; };
  return { o, audit, secrets, auditFile, gate, before };
}

async function joined() {
  const m = machine();
  await m.o.teamJoin({ join_token: cloud.createJoinToken({ maxUses: 20 }), api_base: cloud.base });
  return m;
}

const leaveAndJoinAnother = (m) => async () => {
  await m.o.teamLeave();
  await m.o.teamJoin({ join_token: cloud.createJoinToken({ maxUses: 20 }), api_base: cloud.base });
};

test('the policy write is dropped when the membership changed after the answer arrived', async () => {
  const m = await joined();
  cloud.publishPolicy({ rules: [{ secret: 'A_B', agents: ['*'], deny: true }] });
  // The first serialised section of a sync is the policy write itself.
  m.before(1, leaveAndJoinAnother(m));
  const s = await m.o.teamSync({ upload: false });
  assert.ok(m.gate.fired, 'the leave and join ran inside the window');
  assert.strictEqual(s.policy.status, 'stale');
  assert.ok(!m.secrets.team.policy, 'the policy of the old membership was not stored');
  assert.strictEqual(policy.readCache(), null, 'and no readable copy was written');
  assert.ok(!m.audit.some((r) => /org_policy_v/.test(r.reason)));
});

test('the last-sync record is never written into a newer membership', async () => {
  const m = await joined();
  cloud.publishPolicy({ rules: [] });
  m.before(1, leaveAndJoinAnother(m));
  const s = await m.o.teamSync({ upload: false });
  assert.strictEqual(s.policy.status, 'stale');
  assert.strictEqual(m.secrets.team.last_sync, undefined, 'the new membership has no last_sync from the sync before it');
  assert.ok(!m.audit.some((r) => r.reason === 'team_sync_failed'));
});

test('the upload lock is not created for a membership that is gone', async () => {
  const m = await joined();
  cloud.publishPolicy({ rules: [] });
  fs.writeFileSync(m.auditFile, makeAuditChain({ key: AUDIT_KEY, count: 3 }).map((r) => JSON.stringify(r)).join('\n') + '\n');
  // Sections of a sync: the policy write (1), the readable copies (2), then the upload lock (3).
  m.before(3, async () => { await m.o.teamLeave(); });
  const s = await m.o.teamSync({});
  assert.ok(m.gate.fired);
  assert.strictEqual(s.upload.status, 'stale');
  assert.ok(!fs.existsSync(policy.paths().uploadLock), 'no lock file');
  assert.ok(!fs.existsSync(policy.paths().uploadState), 'no upload state');
});

test('the readable copies are not put back for a membership that was left (status and the hook)', async () => {
  for (const op of ['teamInfo', 'teamHookInfo']) {
    fs.rmSync(process.env.ZN_HOME, { recursive: true, force: true });
    fs.mkdirSync(process.env.ZN_HOME, { recursive: true });
    const m = await joined();
    cloud.publishPolicy({ rules: [] });
    await m.o.teamSync({ upload: false });
    assert.ok(policy.readTeam() && policy.readCache(), 'the copies exist after a sync');
    fs.rmSync(policy.paths().teamFile);
    m.before(1, async () => { await m.o.teamLeave(); });
    await m.o[op]();
    assert.ok(m.gate.fired, op);
    assert.strictEqual(policy.readTeam(), null, op + ': team.json stays deleted');
    assert.strictEqual(policy.readCache(), null, op + ': org-policy.json stays deleted');
  }
});

test('the readable copies are restored while the membership is current, with upload_after_seq', async () => {
  const m = await joined();
  cloud.publishPolicy({ rules: [] });
  await m.o.teamSync({ upload: false });
  const before = JSON.parse(fs.readFileSync(policy.paths().teamFile, 'utf8'));
  fs.rmSync(policy.paths().teamFile);
  fs.rmSync(policy.paths().policyFile);
  await m.o.teamInfo();
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(policy.paths().teamFile, 'utf8')), before, 'team.json is back, upload_after_seq included');
  assert.ok(Number.isInteger(before.upload_after_seq));
  assert.ok(policy.readCache(), 'org-policy.json is back');
});

test('an upload that ends after a leave does not delete the lock a newer upload created', async () => {
  const dir = path.join(HOME, 'lock');
  fs.mkdirSync(dir, { recursive: true });
  const auditFile = path.join(dir, 'audit.jsonl');
  const stateFile = path.join(dir, 'state.json');
  const lockFile = path.join(dir, 'upload.lock');
  const chain = makeAuditChain({ key: AUDIT_KEY, count: 2 });
  fs.writeFileSync(auditFile, chain.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const last = chain[chain.length - 1];
  const api = {
    ingest: async () => {
      // `zn team leave` deleted this upload's lock, then another membership started its own upload.
      fs.unlinkSync(lockFile);
      fs.writeFileSync(lockFile, 'newer upload\n');
      return { status: 200, body: { accepted: chain.length, head: { seq: last.seq, mac: last.mac } } };
    },
  };
  const r = await uploadPending({ auditFile, stateFile, lockFile, api, installId: 'i-1' });
  assert.strictEqual(r.status, 'ok');
  assert.strictEqual(fs.readFileSync(lockFile, 'utf8'), 'newer upload\n', 'the newer upload keeps its lock');
  // And a lock that is still the upload's own is removed as before.
  fs.rmSync(lockFile);
  fs.rmSync(stateFile);
  const again = await uploadPending({ auditFile, stateFile, lockFile, api: { ingest: async () => ({ status: 200, body: { accepted: chain.length, head: { seq: last.seq, mac: last.mac } } }) }, installId: 'i-1' });
  assert.strictEqual(again.status, 'ok');
  assert.ok(!fs.existsSync(lockFile));
});

test('the guard option runs every write of an upload and stops it when it says stale', async () => {
  const dir = path.join(HOME, 'guard');
  fs.mkdirSync(dir, { recursive: true });
  const auditFile = path.join(dir, 'audit.jsonl');
  const stateFile = path.join(dir, 'state.json');
  const lockFile = path.join(dir, 'upload.lock');
  const chain = makeAuditChain({ key: AUDIT_KEY, count: 2 });
  fs.writeFileSync(auditFile, chain.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const api = { ingest: async () => { throw new Error('must not be called'); } };
  const r = await uploadPending({ auditFile, stateFile, lockFile, api, installId: 'i-1', guard: async () => ({ stale: true }) });
  assert.strictEqual(r.status, 'stale');
  assert.ok(!fs.existsSync(lockFile) && !fs.existsSync(stateFile));
});

test('a stale sync is not a good sync: the command exits 1 and says why', () => {
  const stalePolicy = syncOutcome({ policy: { status: 'stale' }, upload: null });
  assert.strictEqual(stalePolicy.ok, false);
  assert.match(stalePolicy.problems[0], /left or changed its organization/);
  const staleUpload = syncOutcome({ policy: { status: 'current' }, upload: { status: 'stale', pending: 2 } });
  assert.strictEqual(staleUpload.ok, false);
  assert.match(staleUpload.problems[0], /audit upload stopped/);
});
