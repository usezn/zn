'use strict';
/*
 * Pending revocations are never dropped: up to 64 are kept and a further leave is refused. A vault written by an older
 * version may still carry a record of a drop (s.revocationsDropped); `zn team status` shows it for 30 days
 * (info.revocations_dropped, never a token). This version never creates one.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-team-rev-dropped-'));
process.env.ZN_HOME = path.join(HOME, '.zn');

// cli.js takes createClient when it loads: replace it first.
const clientModule = require('../lib/vault/client');
let fake = {};
clientModule.createClient = () => new Proxy({}, {
  get(target, prop) {
    if (prop === 'close') return () => {};
    if (typeof fake[prop] === 'function') return fake[prop];
    return () => { throw Object.assign(new Error('unexpected call ' + String(prop)), { code: 'ZN_TEST' }); };
  },
});

const { startFakeTeamServer } = require('./helpers/fake_team_server');
const { makeTeamOps } = require('../lib/team/daemon-ops');
const { runTeamCommand } = require('../lib/team/cli');

const DAY = 86400000;
let cloud;

test.before(async () => { cloud = await startFakeTeamServer(); });
test.after(async () => { await cloud.close(); fs.rmSync(HOME, { recursive: true, force: true }); });
test.beforeEach(() => {
  fake = {};
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

async function capture(fn) {
  const o = process.stdout.write;
  let stdout = '';
  process.stdout.write = (s) => { stdout += s; return true; };
  try { const code = await fn(); return { code, stdout }; } finally { process.stdout.write = o; }
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

test('more than eight pending revocations are all kept, nothing is dropped and nothing is reported as dropped', async () => {
  const m = machine();
  const ids = [];
  for (let i = 0; i < 10; i += 1) ids.push(await joinAndLeave(m));
  assert.deepStrictEqual(m.secrets.pendingRevocations.map((r) => r.install_id), ids);
  assert.strictEqual(m.secrets.revocationsDropped, undefined);
  assert.ok(!m.audit.some((a) => a.reason === 'team_revocation_dropped'));
  assert.strictEqual((await m.o.teamInfo()).revocations_dropped, undefined);
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
  assert.strictEqual(m.secrets.revocationsDropped, undefined);
  assert.ok(!m.audit.some((a) => a.reason === 'team_revocation_dropped'));
});

test('a vault from an older version with more than 64 records keeps all of them and refuses a further leave', async () => {
  const m = machine();
  seed(m, 70);
  await m.o.teamJoin({ join_token: cloud.createJoinToken({ maxUses: 5 }), api_base: cloud.base });
  await assert.rejects(m.o.teamLeave(), /cannot leave another organization yet/);
  assert.strictEqual(m.secrets.pendingRevocations.length, 70);
  assert.strictEqual((await m.o.teamInfo()).revocations.length, 70);
});

test('a drop recorded in the vault by an older version is still shown in teamInfo and in `zn team status`, and expires after 30 days', async () => {
  const m = machine();
  m.secrets.revocationsDropped = { count: 2, last_at: new Date().toISOString(), last_org: 'org_Example12345678', last_install_id: 'inst-old-1' };
  const info = await m.o.teamInfo();
  assert.strictEqual(info.joined, false);
  assert.strictEqual(info.revocations_dropped.count, 2);
  assert.strictEqual(info.revocations_dropped.last_install_id, 'inst-old-1');

  fake.teamInfo = () => m.o.teamInfo();
  const r = await capture(() => runTeamCommand(['team', 'status']));
  assert.strictEqual(r.code, 0);
  assert.match(r.stdout, /WARNING: 2 pending revocations were dropped/);
  assert.match(r.stdout, /installation inst-old-1/);
  assert.match(r.stdout, /older version/);
  assert.match(r.stdout, /remove them from the dashboard/);
  const j = await capture(() => runTeamCommand(['team', 'status', '--json']));
  assert.strictEqual(JSON.parse(j.stdout).revocations_dropped.count, 2);

  m.secrets.revocationsDropped.last_at = new Date(Date.now() - 31 * DAY).toISOString();
  assert.strictEqual((await m.o.teamInfo()).revocations_dropped, undefined);
});

test('status says nothing about drops when none happened', async () => {
  fake.teamInfo = async () => ({ joined: false });
  const r = await capture(() => runTeamCommand(['team', 'status']));
  assert.ok(!/dropped/.test(r.stdout));
});
