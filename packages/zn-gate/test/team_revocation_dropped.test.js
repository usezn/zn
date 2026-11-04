'use strict';
/*
 * Pending revocations are never dropped: up to 64 are kept and a further leave is refused.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-team-rev-dropped-'));
process.env.ZN_HOME = path.join(HOME, '.zn');

const { startFakeTeamServer } = require('./helpers/fake_team_server');
const { makeTeamOps } = require('../lib/team/daemon-ops');

const DAY = 86400000;
let cloud;

test.before(async () => { cloud = await startFakeTeamServer(); });
test.after(async () => { await cloud.close(); fs.rmSync(HOME, { recursive: true, force: true }); });
test.beforeEach(() => {
  cloud.setOrgActive(true);
  cloud.setLeaveMode({ status: 503 });
  fs.rmSync(process.env.ZN_HOME, { recursive: true, force: true });
  fs.mkdirSync(process.env.ZN_HOME, { recursive: true });
});

function machine() {
  const audit = [];
  const secrets = { auditKey: 'ab'.repeat(32), secrets: {} };
  const state = {
    opts: { home: process.env.ZN_HOME },
    paths: { auditFile: path.join(process.env.ZN_HOME, 'audit.jsonl') },
    loadSecrets: async () => secrets,
    saveSecrets: async () => {},
    serial: (fn) => fn(),
  };
  const o = makeTeamOps({ state, fetchImpl: fetch, writeAudit: (r) => audit.push(r), confirmOutOfBand: async () => {} });
  return { o, audit, secrets };
}

async function joinAndLeave(m) {
  const r = await m.o.teamJoin({ join_token: cloud.createJoinToken({ maxUses: 50 }), api_base: cloud.base });
  await m.o.teamLeave();
  return r.install_id;
}

function seed(m, n) {
  m.secrets.pendingRevocations = [];
  for (let i = 0; i < n; i += 1) {
    m.secrets.pendingRevocations.push({
      org: 'org_Example12345678', install_id: 'inst-' + i, api_base: cloud.base, install_token: 'zni_fake' + i,
      since: new Date().toISOString(), tries: 1, next_try_at: new Date(Date.now() + DAY).toISOString(),
    });
  }
}

test('more than eight pending revocations are all kept, nothing is dropped', async () => {
  const m = machine();
  const ids = [];
  for (let i = 0; i < 10; i += 1) ids.push(await joinAndLeave(m));
  assert.deepStrictEqual(m.secrets.pendingRevocations.map((r) => r.install_id), ids);
});

test('at the limit of 64 nothing is dropped: the next leave is refused with the next step and the machine stays joined', async () => {
  const m = machine();
  seed(m, 63);
  const last = await joinAndLeave(m);
  assert.strictEqual(m.secrets.pendingRevocations.length, 64);
  assert.strictEqual(m.secrets.pendingRevocations[63].install_id, last);
  await m.o.teamJoin({ join_token: cloud.createJoinToken({ maxUses: 5 }), api_base: cloud.base });
  await assert.rejects(m.o.teamLeave(), /cannot leave another organization yet: 64 earlier leaves.*zn team sync.*admin/s);
  assert.strictEqual(m.secrets.pendingRevocations.length, 64);
  assert.strictEqual(m.secrets.pendingRevocations[0].install_id, 'inst-0', 'the oldest is still there');
  assert.ok(m.secrets.team, 'the machine is still joined');
});

test('a vault from an older version with more than 64 records keeps all of them and refuses a further leave', async () => {
  const m = machine();
  seed(m, 70);
  await m.o.teamJoin({ join_token: cloud.createJoinToken({ maxUses: 5 }), api_base: cloud.base });
  await assert.rejects(m.o.teamLeave(), /cannot leave another organization yet/);
  assert.strictEqual(m.secrets.pendingRevocations.length, 70);
  assert.strictEqual((await m.o.teamInfo()).revocations.length, 70);
});
