'use strict';
/*
 * `zn team status-report stop` is confirmed on the vault's own channel like `zn team leave`, and sends one last report.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-team-sr-stop-'));
process.env.ZN_HOME = path.join(HOME, '.zn');

const { startFakeTeamServer } = require('./helpers/fake_team_server');
const { makeTeamOps } = require('../lib/team/daemon-ops');
const { isAllowedBody } = require('../lib/team/status-report');

let cloud;
test.before(async () => { cloud = await startFakeTeamServer(); });
test.after(async () => { await cloud.close(); fs.rmSync(HOME, { recursive: true, force: true }); });
test.beforeEach(() => {
  cloud.setOrgActive(true);
  cloud.requests.length = 0;
  fs.rmSync(process.env.ZN_HOME, { recursive: true, force: true });
  fs.mkdirSync(process.env.ZN_HOME, { recursive: true });
});

function machine() {
  const audit = [];
  const asked = [];
  const secrets = { auditKey: 'ab'.repeat(32), secrets: {} };
  const answer = { fn: async () => true };
  const state = {
    opts: { home: process.env.ZN_HOME },
    paths: { auditFile: path.join(process.env.ZN_HOME, 'audit.jsonl') },
    loadSecrets: async () => secrets, saveSecrets: async () => {}, serial: (fn) => fn(),
  };
  const o = makeTeamOps({
    state, fetchImpl: fetch, writeAudit: (r) => audit.push(r),
    confirmOutOfBand: async (req, ev) => { asked.push({ req, ev }); return answer.fn(req, ev); },
  });
  return { o, audit, secrets, asked, answer };
}
const sent = () => cloud.requests.filter((q) => q.method === 'POST' && q.path === '/v1/org/install/status');
async function joined() {
  const m = machine();
  await m.o.teamJoin({ join_token: cloud.createJoinToken({ maxUses: 20 }), api_base: cloud.base });
  m.asked.length = 0; m.audit.length = 0; cloud.requests.length = 0;
  return m;
}

test('stop asks on the vault channel, sends one final report, then turns the report off', async () => {
  const m = await joined();
  const r = await m.o.teamStatusReport({ action: 'stop' });
  assert.strictEqual(r.on, false);
  assert.deepStrictEqual(r.final_report, { sent: true });
  assert.strictEqual(m.asked.length, 1);
  assert.strictEqual(m.asked[0].ev.reason, 'team_status_report_stop');
  assert.match(m.asked[0].req.title, /^stop the status report to organization /);
  assert.strictEqual(sent().length, 1);
  assert.ok(isAllowedBody([...cloud.state.installs.values()][0].status));
  assert.ok(m.audit.some((a) => a.reason === 'team_status_report_off'));
  assert.strictEqual(m.secrets.team.status_report, undefined);
});

test('stop refused (no channel, agent or declined): nothing is sent and the report stays on', async () => {
  const m = await joined();
  m.answer.fn = async () => { const e = new Error('no confirmation channel'); e.noChannel = true; throw e; };
  await assert.rejects(m.o.teamStatusReport({ action: 'stop' }), /no confirmation channel/);
  m.answer.fn = async () => { throw new Error('declined by the user'); };
  await assert.rejects(m.o.teamStatusReport({ action: 'stop' }), /declined/);
  assert.strictEqual(sent().length, 0);
  assert.strictEqual(m.secrets.team.status_report.accepted, true);
});

test('a failed final report still stops the report and says so', async () => {
  const m = await joined();
  cloud.setOrgActive(false);
  try {
    const r = await m.o.teamStatusReport({ action: 'stop' });
    assert.strictEqual(r.on, false);
    assert.strictEqual(r.final_report.sent, false);
    assert.ok(r.final_report.error);
    assert.strictEqual(m.secrets.team.status_report, undefined);
    assert.ok(m.audit.some((a) => a.reason === 'team_status_report_off'));
  } finally { cloud.setOrgActive(true); }
});

test('stop when the report is already off asks nothing', async () => {
  const m = await joined();
  await m.o.teamStatusReport({ action: 'stop' });
  m.asked.length = 0;
  const r = await m.o.teamStatusReport({ action: 'stop' });
  assert.strictEqual(r.already, true);
  assert.strictEqual(m.asked.length, 0);
});
