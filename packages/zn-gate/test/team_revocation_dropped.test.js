'use strict';
/*
 * A ninth pending revocation pushes the oldest one out of the vault (the list keeps 8). That is no longer silent:
 * one audit record per dropped entry, and a warning in `zn team status` (info.revocations_dropped, never a token).
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

test('the count grows with each drop, and the warning goes away after 30 days', async () => {
  const m = machine();
  for (let i = 0; i < 10; i += 1) await joinAndLeave(m);
  assert.strictEqual(m.secrets.revocationsDropped.count, 2);
  assert.strictEqual(m.audit.filter((a) => a.reason === 'team_revocation_dropped').length, 2);
  assert.strictEqual((await m.o.teamInfo()).revocations_dropped.count, 2);
  m.secrets.revocationsDropped.last_at = new Date(Date.now() - 31 * DAY).toISOString();
  assert.strictEqual((await m.o.teamInfo()).revocations_dropped, undefined);
});

test('status says nothing about drops when none happened', async () => {
  fake.teamInfo = async () => ({ joined: false });
  const r = await capture(() => runTeamCommand(['team', 'status']));
  assert.ok(!/dropped/.test(r.stdout));
});
