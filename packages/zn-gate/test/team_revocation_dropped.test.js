'use strict';
/*
 * A ninth pending revocation pushes the oldest one out of the vault (the list keeps 8). That is never silent:
 * one audit record per dropped entry, and a warning in `zn team status` (info.revocations_dropped, never a token) that
 * lists every dropped installation id until the server confirms or an admin dismisses it (no expiry).
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

test('eight pending revocations are all kept and nothing is reported as dropped', async () => {
  const m = await machine();
  for (let i = 0; i < 8; i += 1) await joinAndLeave(m);
  assert.strictEqual(m.secrets.pendingRevocations.length, 8);
  assert.strictEqual(m.secrets.revocationsDropped, undefined);
  assert.ok(!m.audit.some((a) => a.reason === 'team_revocation_dropped'));
  assert.strictEqual((await m.o.teamInfo()).revocations_dropped, undefined);
});

test('the ninth drops the oldest, leaves an audit record and a warning in teamInfo and in `zn team status`', async () => {
  const m = machine();
  const ids = [];
  for (let i = 0; i < 9; i += 1) ids.push(await joinAndLeave(m));
  assert.strictEqual(m.secrets.pendingRevocations.length, 8);
  assert.ok(!m.secrets.pendingRevocations.some((r) => r.install_id === ids[0]), 'the oldest is the one dropped');
  const dropped = m.audit.filter((a) => a.reason === 'team_revocation_dropped');
  assert.strictEqual(dropped.length, 1);
  assert.strictEqual(dropped[0].decision, 'error');
  const info = await m.o.teamInfo();
  assert.strictEqual(info.joined, false);
  assert.strictEqual(info.revocations_dropped.count, 1);
  assert.strictEqual(info.revocations_dropped.last_install_id, ids[0]);
  assert.ok(!JSON.stringify(info).includes(m.secrets.pendingRevocations[0].install_token), 'no token in the view');

  fake.teamInfo = () => m.o.teamInfo();
  const r = await capture(() => runTeamCommand(['team', 'status']));
  assert.strictEqual(r.code, 0);
  assert.match(r.stdout, /WARNING: 1 pending revocation was dropped/);
  assert.match(r.stdout, new RegExp('installation ' + ids[0]));
  assert.match(r.stdout, /remove it from the dashboard/);
  const j = await capture(() => runTeamCommand(['team', 'status', '--json']));
  assert.strictEqual(JSON.parse(j.stdout).revocations_dropped.count, 1);
});

test('every dropped installation id is kept, and the warning does not expire after 30 days', async () => {
  const m = machine();
  const ids = [];
  for (let i = 0; i < 12; i += 1) ids.push(await joinAndLeave(m));
  assert.strictEqual(m.secrets.revocationsDropped.items.length, 4);
  assert.strictEqual(m.audit.filter((a) => a.reason === 'team_revocation_dropped').length, 4);
  let info = await m.o.teamInfo();
  assert.strictEqual(info.revocations_dropped.count, 4);
  assert.deepStrictEqual(info.revocations_dropped.installations.map((x) => x.install_id), ids.slice(0, 4));
  assert.ok(!JSON.stringify(info).includes(m.secrets.pendingRevocations[0].install_token), 'no token in the view');
  for (const x of m.secrets.revocationsDropped.items) x.dropped_at = new Date(Date.now() - 45 * DAY).toISOString();
  m.secrets.revocationsDropped.last_at = new Date(Date.now() - 45 * DAY).toISOString();
  info = await m.o.teamInfo();
  assert.strictEqual(info.revocations_dropped.count, 4, 'still warned after 45 days');
  fake.teamInfo = () => m.o.teamInfo();
  const r = await capture(() => runTeamCommand(['team', 'status']));
  for (const id of ids.slice(0, 4)) assert.match(r.stdout, new RegExp('installation ' + id));
});

test('the list of dropped ids is capped on disk and the rest is only counted', async () => {
  const m = machine();
  m.secrets.revocationsDropped = {
    items: Array.from({ length: 200 }, (_, i) => ({ org: 'org_x', install_id: 'old-' + i, dropped_at: new Date().toISOString() })),
    omitted: 5, last_at: new Date().toISOString(),
  };
  for (let i = 0; i < 9; i += 1) await joinAndLeave(m);
  assert.strictEqual(m.secrets.revocationsDropped.items.length, 200);
  assert.strictEqual(m.secrets.revocationsDropped.omitted, 6);
  assert.strictEqual((await m.o.teamInfo()).revocations_dropped.count, 206);
  assert.strictEqual(m.secrets.revocationsDropped.items[0].install_id, 'old-1');
});

test('an older vault entry (count and last id only) is still read', async () => {
  const m = machine();
  m.secrets.revocationsDropped = { count: 3, last_at: new Date(Date.now() - 90 * DAY).toISOString(), last_org: 'org_x', last_install_id: 'inst-old' };
  const v = (await m.o.teamInfo()).revocations_dropped;
  assert.strictEqual(v.count, 3);
  assert.strictEqual(v.last_install_id, 'inst-old');
  assert.strictEqual(v.omitted, 2);
});

test('the server confirming a retry removes that installation from the dropped list', async () => {
  const m = machine();
  await joinAndLeave(m);
  const rec = m.secrets.pendingRevocations[0];
  m.secrets.revocationsDropped = { items: [{ org: rec.org, install_id: rec.install_id, dropped_at: new Date().toISOString() }, { org: 'org_x', install_id: 'other', dropped_at: new Date().toISOString() }], omitted: 0, last_at: new Date().toISOString() };
  cloud.setLeaveMode(null);
  await assert.rejects(m.o.teamSync({}), /completed/);
  assert.strictEqual(m.secrets.pendingRevocations, undefined);
  assert.deepStrictEqual(m.secrets.revocationsDropped.items.map((x) => x.install_id), ['other']);
});

test('an admin dismisses dropped installations one by one or all at once, and the warning goes away', async () => {
  const m = machine();
  const ids = [];
  for (let i = 0; i < 10; i += 1) ids.push(await joinAndLeave(m));
  assert.strictEqual((await m.o.teamInfo()).revocations_dropped.count, 2);
  const one = await m.o.teamDismissDropped({ install_id: ids[0] });
  assert.deepStrictEqual(one, { dismissed: 1, remaining: 1 });
  assert.strictEqual((await m.o.teamInfo()).revocations_dropped.last_install_id, ids[1]);
  assert.ok(m.audit.some((a) => a.reason === 'team_revocation_dropped_dismissed'));
  const all = await m.o.teamDismissDropped({ all: true });
  assert.deepStrictEqual(all, { dismissed: 1, remaining: 0 });
  assert.strictEqual((await m.o.teamInfo()).revocations_dropped, undefined);
  assert.strictEqual(m.secrets.revocationsDropped, undefined);
  await assert.rejects(() => m.o.teamDismissDropped({}));
});

test('status says nothing about drops when none happened', async () => {
  fake.teamInfo = async () => ({ joined: false });
  const r = await capture(() => runTeamCommand(['team', 'status']));
  assert.ok(!/dropped/.test(r.stdout));
});
