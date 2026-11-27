'use strict';
/*
 * The status report through a real vault daemon: the client call reaches the operation, the acceptance dialog is
 * asked on the daemon's own channel, and `teamInfo` shows what was sent.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-team-status-daemon-'));
process.env.ZN_HOME = path.join(HOME, '.zn');
process.env.ZN_KEYCHAIN_BACKEND = 'passphrase';

const keychain = require('../lib/vault/keychain');
const daemon = require('../lib/vault/daemon');
const { createClient } = require('../lib/vault/client');
const { startFakeTeamServer } = require('./helpers/fake_team_server');
const { isAllowedBody } = require('../lib/team/status-report');

const confirmations = [];
let answer = true;
const confirmFn = { current: null };
const confirm = async (req) => { if (confirmFn.current) return confirmFn.current(req); confirmations.push(req); return answer; };
let srv = null;
let cloud = null;
let vault = null;

test.before(async () => {
  const created = await keychain.initIdentity({ passphrase: 'correct horse battery staple', workFactor: 10 });
  srv = await daemon.serve({ identity: created.identity, ttlMs: 600000, idleMs: 600000, confirm, teamSyncMs: 0 });
  vault = createClient({});
  cloud = await startFakeTeamServer();
});

test.after(async () => {
  if (vault) vault.close();
  if (srv) await srv.close();
  if (cloud) await cloud.close();
  fs.rmSync(HOME, { recursive: true, force: true });
});

test('join turns the report on, the daemon sends it, stop and accept go through the client', async () => {
  cloud.publishPolicy({ rules: [] });
  await vault.teamJoin({ join_token: cloud.createJoinToken({ maxUses: 5 }), api_base: cloud.base, agent: 'claude-code' });
  const dialog = confirmations.filter((c) => c.kind === 'team').pop();
  assert.ok(dialog.fields.some(([k, v]) => k === 'Status' && /No paths, no names/.test(v)));
  await vault.teamSync({});
  const inst = [...cloud.state.installs.values()][0];
  assert.ok(isAllowedBody(inst.status));
  let info = await vault.teamInfo();
  assert.strictEqual(info.status_report.on, true);
  assert.deepStrictEqual(info.status_report.last.body, inst.status);

  assert.strictEqual((await vault.teamStatusReport({ action: 'stop' })).on, false);
  await vault.teamSync({});
  assert.strictEqual(inst.statusReports, 1);

  answer = false;
  await assert.rejects(vault.teamStatusReport({ action: 'accept' }), /declined/);
  answer = true;
  assert.strictEqual((await vault.teamStatusReport({ action: 'accept' })).on, true);
  assert.match(confirmations.filter((c) => c.kind === 'team').pop().title, /^send a status report to organization /);
  await vault.teamSync({});
  assert.strictEqual(inst.statusReports, 2);
  info = await vault.teamInfo();
  assert.strictEqual(info.status_report.via, 'accept');
});

test('no status report while the organization has no active subscription (402), and again once it has one', async () => {
  // Count the requests that reach the server, not the reports it accepts: the server may refuse a report for an
  // inactive organization, which would hide a client that keeps sending.
  const sent = () => cloud.requests.filter((q) => q.method === 'POST' && q.path === '/v1/org/install/status').length;
  assert.strictEqual((await vault.teamInfo()).status_report.on, true);
  cloud.setOrgActive(false);
  try {
    const before = sent();
    await vault.teamSync({});
    await vault.teamSync({});
    assert.strictEqual(sent(), before, 'a 402 sync sends no report');
  } finally {
    cloud.setOrgActive(true);
  }
  const before = sent();
  await vault.teamSync({});
  assert.strictEqual(sent(), before + 1, 'reports resume once the subscription is active');
});

test('accept with no confirmation channel stores nothing and sends nothing', async () => {
  await vault.teamStatusReport({ action: 'stop' });
  const inst = [...cloud.state.installs.values()][0];
  const before = inst.statusReports;
  const saved = confirmations.length;
  const noChannel = async () => { const e = new Error('no confirmation channel'); e.noChannel = true; throw e; };
  const prev = confirmFn.current;
  confirmFn.current = noChannel;
  try {
    await assert.rejects(vault.teamStatusReport({ action: 'accept' }));
  } finally {
    confirmFn.current = prev;
  }
  assert.strictEqual(confirmations.length, saved);
  let info = await vault.teamInfo();
  assert.strictEqual(info.status_report.on, false);
  await vault.teamSync({});
  assert.strictEqual(inst.statusReports, before);
  info = await vault.teamInfo();
  assert.strictEqual(info.status_report.on, false);
  assert.strictEqual(info.status_report.last, null);
});

test('a join through the client still needs the dialog, so there is no consent without it', async () => {
  await vault.teamLeave({}).catch(() => {});
  const noChannel = async () => { const e = new Error('no confirmation channel'); e.noChannel = true; throw e; };
  const prev = confirmFn.current;
  confirmFn.current = noChannel;
  try {
    await assert.rejects(vault.teamJoin({ join_token: cloud.createJoinToken({ maxUses: 5 }), api_base: cloud.base, agent: 'claude-code' }));
  } finally {
    confirmFn.current = prev;
  }
  const info = await vault.teamInfo();
  assert.strictEqual(info.joined, false);
});
