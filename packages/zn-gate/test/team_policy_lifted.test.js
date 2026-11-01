'use strict';
/*
 * zn Team in the vault daemon: a policy version that removes or loosens a
 * restriction is shown (zn team status, teamInfo) and audited, and the
 * readable copies the hooks use are put back from the vault when they are
 * deleted or edited.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-team-lifted-'));
process.env.ZN_HOME = path.join(HOME, '.zn');

const { startFakeTeamServer } = require('./helpers/fake_team_server');
const { makeTeamOps } = require('../lib/team/daemon-ops');
const policy = require('../lib/team/policy');

const AUDIT_KEY = 'ab'.repeat(32);
const ACME = { id: 'acme', pattern: 'ACME-[A-Z0-9]{24}', type: 'ACME_TOKEN' };
let cloud;

test.before(async () => { cloud = await startFakeTeamServer(); });
test.after(async () => { await cloud.close(); fs.rmSync(HOME, { recursive: true, force: true }); });
test.beforeEach(() => {
  cloud.setOrgActive(true);
  fs.rmSync(process.env.ZN_HOME, { recursive: true, force: true });
  fs.mkdirSync(process.env.ZN_HOME, { recursive: true });
});

/** One machine: in-memory vault state, audit records kept in a list, the join dialog approved. */
async function joined() {
  const audit = [];
  const secrets = { auditKey: AUDIT_KEY, secrets: {} };
  const state = {
    opts: { home: process.env.ZN_HOME },
    paths: { auditFile: path.join(process.env.ZN_HOME, 'audit.jsonl') },
    loadSecrets: async () => secrets,
    saveSecrets: async () => {},
    serial: (fn) => fn(),
  };
  const o = makeTeamOps({ state, fetchImpl: fetch, writeAudit: (r) => audit.push(r), isClosed: () => false, confirmOutOfBand: async () => {} });
  const r = await o.teamJoin({ join_token: cloud.createJoinToken({ maxUses: 20 }), api_base: cloud.base, agent: 'claude-code' });
  return { o, audit, secrets, r };
}

const sync = (m) => m.o.teamSync({ upload: false });

test('a version that removes a block and a detector is shown in status, kept in both copies and audited', async () => {
  const m = await joined();
  cloud.publishPolicy({ rules: [{ secret: 'PROD_*', agents: ['*'], deny: true }, { secret: 'STRIPE_KEY', agents: ['*'], allowHosts: ['api.stripe.com'] }], detectors: [ACME] });
  const first = await sync(m);
  assert.deepStrictEqual(first.policy, { status: 'updated', version: cloud.state.policyVersion });
  assert.strictEqual((await m.o.teamInfo()).policy.change, null, 'nothing was lifted by the first policy');

  cloud.publishPolicy({ rules: [{ secret: 'STRIPE_KEY', agents: ['*'], allowHosts: ['api.stripe.com', 'files.example.net'] }] });
  const second = await sync(m);
  assert.strictEqual(second.policy.status, 'updated');
  assert.strictEqual(second.policy.lifted, 3);

  const info = await m.o.teamInfo();
  assert.strictEqual(info.policy.change.from, first.policy.version);
  assert.strictEqual(info.policy.change.to, second.policy.version);
  assert.strictEqual(info.policy.change.count, 3);
  assert.deepStrictEqual(info.policy.change.items.map((i) => i.kind).sort(), ['block_removed', 'detector_removed', 'hosts_widened']);

  const n = second.policy.version;
  assert.ok(m.audit.some((a) => a.reason === 'org_policy_lifted:v' + first.policy.version + '-v' + n + ':n3' && a.decision === 'allow' && a.mode === 'set'));
  // The readable copy carries it for `zn team status` with a locked vault and for the hooks.
  assert.strictEqual(policy.readCache().change.count, 3);
  assert.strictEqual(policy.state({}).change.to, n);
  assert.ok(!JSON.stringify(info).includes('zni_'), 'no install token');
});

test('a version that only adds restrictions records nothing and clears an earlier record', async () => {
  const m = await joined();
  cloud.publishPolicy({ rules: [{ secret: 'PROD_*', agents: ['*'], deny: true }] });
  await sync(m);
  cloud.publishPolicy({ rules: [] });
  assert.strictEqual((await sync(m)).policy.lifted, 1);
  assert.ok((await m.o.teamInfo()).policy.change);
  const count = m.audit.filter((a) => /^org_policy_lifted:/.test(a.reason)).length;
  cloud.publishPolicy({ rules: [{ secret: 'PROD_*', agents: ['*'], deny: true }] });
  const s = await sync(m);
  assert.strictEqual(s.policy.lifted, undefined);
  assert.strictEqual((await m.o.teamInfo()).policy.change, null);
  assert.strictEqual(policy.readCache().change, undefined);
  assert.strictEqual(m.audit.filter((a) => /^org_policy_lifted:/.test(a.reason)).length, count);
});

test('the record survives a refresh of the same version and a copy restored from the vault', async () => {
  const m = await joined();
  cloud.publishPolicy({ rules: [{ secret: 'PROD_*', agents: ['*'], deny: true }] });
  await sync(m);
  cloud.publishPolicy({ rules: [] });
  await sync(m);
  assert.strictEqual(m.secrets.team.policy.change.count, 1);
  // "Still current" keeps the record.
  assert.strictEqual((await sync(m)).policy.status, 'current');
  assert.strictEqual(m.secrets.team.policy.change.count, 1);
  fs.rmSync(policy.paths().policyFile);
  await sync(m);
  assert.strictEqual(policy.readCache().change.count, 1);
  // A cleaned-up copy (someone removed the record by hand) is put back too.
  const c = JSON.parse(fs.readFileSync(policy.paths().policyFile, 'utf8'));
  delete c.change;
  fs.writeFileSync(policy.paths().policyFile, JSON.stringify(c));
  await sync(m);
  assert.strictEqual(policy.readCache().change.count, 1);
});

test('sync puts team.json back from the vault when it was deleted or edited, also offline', async () => {
  const m = await joined();
  cloud.publishPolicy({ rules: [], detectors: [ACME] });
  await sync(m);
  const file = policy.paths().teamFile;
  const original = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.rmSync(file);
  assert.strictEqual(policy.readTeam(), null);
  await sync(m);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), original);
  // Edited to another key: replaced by the vault's copy.
  const edited = Object.assign({}, original, { org: 'org_Somebody12345678' });
  fs.writeFileSync(file, JSON.stringify(edited));
  await sync(m);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), original);
  // The server is unreachable: the copy still comes back.
  fs.rmSync(file);
  const offline = makeTeamOps({
    state: { opts: { home: process.env.ZN_HOME }, paths: { auditFile: path.join(process.env.ZN_HOME, 'audit.jsonl') }, loadSecrets: async () => m.secrets, saveSecrets: async () => {}, serial: (fn) => fn() },
    fetchImpl: async () => { throw new TypeError('fetch failed'); }, writeAudit: () => {}, isClosed: () => false, confirmOutOfBand: async () => {},
  });
  const s = await offline.teamSync({ upload: false });
  assert.strictEqual(s.policy.status, 'offline');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), original);
  // And so does zn team status.
  fs.rmSync(file);
  await m.o.teamInfo();
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), original);
});

test('teamHookInfo gives a hook the detectors of the vault policy and restores both copies', async () => {
  const m = await joined();
  assert.deepStrictEqual(await m.o.teamHookInfo(), { joined: true, org: m.r.org, kid: m.secrets.team.pin.kid, state: 'none', version: null, detectors: [], change: null, change_shown: null, pin_mismatch: false });
  cloud.publishPolicy({ rules: [], detectors: [ACME] });
  await sync(m);
  fs.rmSync(policy.paths().teamFile);
  fs.rmSync(policy.paths().policyFile);
  assert.strictEqual(policy.state({}).state, 'none');
  const r = await m.o.teamHookInfo();
  assert.strictEqual(r.joined, true);
  assert.strictEqual(r.state, 'active');
  assert.deepStrictEqual(r.detectors, [ACME]);
  assert.strictEqual(policy.state({}).state, 'active');
  assert.strictEqual(policy.state({}).policy.detectors.length, 1);
  assert.ok(!JSON.stringify(r).includes('zni_'), 'no install token');
});

test('teamHookInfo says not joined, and reports a vault policy that does not verify', async () => {
  const none = await (async () => {
    const secrets = { auditKey: AUDIT_KEY, secrets: {} };
    const o = makeTeamOps({ state: { opts: { home: process.env.ZN_HOME }, paths: {}, loadSecrets: async () => secrets, saveSecrets: async () => {}, serial: (fn) => fn() }, fetchImpl: fetch, writeAudit: () => {}, confirmOutOfBand: async () => {} });
    return o.teamHookInfo();
  })();
  assert.deepStrictEqual(none, { joined: false });
  const m = await joined();
  cloud.publishPolicy({ rules: [], detectors: [ACME] });
  await sync(m);
  // The organization's key changed under the held policy: it no longer verifies.
  m.secrets.team.pin = Object.assign({}, m.secrets.team.pin, { kid: '0123456789abcdef' });
  const r = await m.o.teamHookInfo();
  assert.strictEqual(r.joined, true);
  assert.strictEqual(r.state, 'invalid');
  assert.deepStrictEqual(r.detectors, []);
});
