'use strict';
/*
 * Membership generation: a sync only applies what it fetched while the
 * organization, installation, token and generation it started with are still
 * the ones in the vault. A stale answer (the machine left, joined another
 * organization or rejoined while the request was in flight) is dropped and
 * nothing is written: not the policy, the readable copy or the upload state.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-team-gen-'));
process.env.ZN_HOME = path.join(HOME, '.zn');

const { startFakeTeamServer, makeAuditChain } = require('./helpers/fake_team_server');
const { makeTeamOps } = require('../lib/team/daemon-ops');
const policy = require('../lib/team/policy');

const AUDIT_KEY = 'ab'.repeat(32);
let cloud;
let hook = null; // runs once when the named request is made, before it is answered

test.before(async () => { cloud = await startFakeTeamServer(); });
test.after(async () => { await cloud.close(); fs.rmSync(HOME, { recursive: true, force: true }); });
test.beforeEach(() => {
  hook = null;
  cloud.setOrgActive(true);
  fs.rmSync(process.env.ZN_HOME, { recursive: true, force: true });
  fs.mkdirSync(process.env.ZN_HOME, { recursive: true });
});

async function fetchImpl(url, init) {
  if (hook && String(url).endsWith(hook.suffix)) {
    const h = hook;
    hook = null;
    await h.fn();
  }
  return fetch(url, init);
}

function machine() {
  const audit = [];
  const secrets = { auditKey: AUDIT_KEY, secrets: {} };
  const auditFile = path.join(process.env.ZN_HOME, 'audit.jsonl');
  const state = {
    opts: { home: process.env.ZN_HOME },
    paths: { auditFile },
    loadSecrets: async () => secrets,
    saveSecrets: async () => {},
    serial: (fn) => fn(),
  };
  const o = makeTeamOps({ state, fetchImpl, writeAudit: (r) => audit.push(r), confirmOutOfBand: async () => {} });
  return { o, audit, secrets, auditFile };
}

async function joined() {
  const m = machine();
  m.r = await m.o.teamJoin({ join_token: cloud.createJoinToken({ maxUses: 20 }), api_base: cloud.base });
  return m;
}

test('a normal sync still applies the policy and uploads', async () => {
  const m = await joined();
  cloud.publishPolicy({ rules: [] });
  fs.writeFileSync(m.auditFile, makeAuditChain({ key: AUDIT_KEY, count: 2 }).map((r) => JSON.stringify(r)).join('\n') + '\n');
  const s = await m.o.teamSync({});
  assert.strictEqual(s.policy.status, 'updated');
  assert.strictEqual(s.upload.status, 'ok');
  assert.ok(m.secrets.team.policy.envelope);
  assert.ok(policy.readCache());
});

test('joining and leaving each bump the generation, and it survives leaving', async () => {
  const m = await joined();
  assert.strictEqual(m.secrets.team.gen, 1);
  assert.strictEqual(m.secrets.teamGen, 1);
  await m.o.teamJoin({ join_token: cloud.createJoinToken(), api_base: cloud.base });
  assert.strictEqual(m.secrets.team.gen, 2, 'reconnecting is a new membership');
  await m.o.teamLeave();
  assert.strictEqual(m.secrets.team, undefined);
  assert.strictEqual(m.secrets.teamGen, 3);
  await m.o.teamJoin({ join_token: cloud.createJoinToken(), api_base: cloud.base });
  assert.strictEqual(m.secrets.team.gen, 4);
});

for (const [what, change] of [
  ['another organization', (t) => { t.org = 'org_SomethingElse1234'; }],
  ['another installation', (t) => { t.install_id = '00000000-0000-4000-8000-000000000000'; }],
  ['an older token', (t) => { t.install_token = 'zni_' + 'x'.repeat(40); }],
  ['an older generation', (t) => { t.gen += 1; }],
]) {
  test('a policy answer for ' + what + ' is refused and nothing is applied', async () => {
    const m = await joined();
    cloud.publishPolicy({ rules: [{ secret: 'A_B', agents: ['*'], deny: true }] });
    hook = { suffix: '/v1/org/policy', fn: () => change(m.secrets.team) };
    const s = await m.o.teamSync({});
    assert.deepStrictEqual(s, { policy: { status: 'stale' }, upload: null });
    assert.ok(!m.secrets.team.policy, 'policy not stored');
    assert.strictEqual(policy.readCache(), null, 'readable copy not written');
    assert.ok(!m.audit.some((r) => /org_policy_v/.test(r.reason)), 'not audited as applied');
  });
}

test('leaving and joining another membership during the request drops the old answer', async () => {
  const m = await joined();
  cloud.publishPolicy({ rules: [] });
  hook = { suffix: '/v1/org/policy', fn: async () => {
    await m.o.teamLeave();
    await m.o.teamJoin({ join_token: cloud.createJoinToken(), api_base: cloud.base });
  } };
  const before = m.secrets.team.install_token;
  const s = await m.o.teamSync({});
  assert.strictEqual(s.policy.status, 'stale');
  assert.notStrictEqual(m.secrets.team.install_token, before);
  assert.ok(!m.secrets.team.policy);
  assert.strictEqual(policy.readCache(), null);
});

test('a membership that changes during an upload writes no upload state and sends no more batches', async () => {
  const m = await joined();
  cloud.publishPolicy({ rules: [] });
  fs.writeFileSync(m.auditFile, makeAuditChain({ key: AUDIT_KEY, count: 3 }).map((r) => JSON.stringify(r)).join('\n') + '\n');
  hook = { suffix: '/v1/audit/ingest', fn: async () => { await m.o.teamLeave(); } };
  const s = await m.o.teamSync({});
  assert.strictEqual(s.upload.status, 'stale');
  assert.ok(!fs.existsSync(policy.paths().uploadState), 'no upload state for the team that was left');
  assert.strictEqual(policy.readTeam(), null);
});
