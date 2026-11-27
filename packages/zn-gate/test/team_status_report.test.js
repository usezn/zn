'use strict';
/*
 * The Team status report: what a machine tells its organization after each sync (zn-gate version, OS, the policy
 * version and state, which agents have hooks) and the rule that it is sent only after the person accepted it:
 * by joining (the dialog lists it) or, on a machine that joined before it existed, by one explicit acceptance.
 * The zn cloud is the local stand-in server.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-team-status-report-'));
process.env.ZN_HOME = path.join(HOME, '.zn');

const { startFakeTeamServer } = require('./helpers/fake_team_server');
const { makeTeamOps } = require('../lib/team/daemon-ops');
const { createApi } = require('../lib/team/api');
const { buildStatusBody, isAllowedBody, agentsFrom, AGENT_IDS } = require('../lib/team/status-report');
const { CODES } = require('../lib/errors');

const VERSION = require('../package.json').version;
const STATUS_PATH = '/v1/org/install/status';
const AUDIT_KEY = 'ab'.repeat(32);
const DAY = 86400000;
let cloud;
let net;

test.before(async () => { cloud = await startFakeTeamServer(); });
test.after(async () => { await cloud.close(); fs.rmSync(HOME, { recursive: true, force: true }); });
test.beforeEach(() => {
  net = { throwError: false };
  cloud.setOrgActive(true);
  cloud.setStatusMode(null);
  cloud.requests.length = 0; // the counts below are per test
  fs.rmSync(process.env.ZN_HOME, { recursive: true, force: true });
  fs.mkdirSync(process.env.ZN_HOME, { recursive: true });
});

async function fetchImpl(url, init) {
  if (net.throwError) throw new TypeError('fetch failed');
  return fetch(url, init);
}

/* What `zn hooks list` would find, with paths and reasons that must never reach the report. */
const HOOKS = {
  agents: [
    { id: 'claude-code', name: 'Claude Code', files: [{ file: '/home/alice/.claude/settings.json', scope: 'user', rows: [{ status: 'OK', command: '/home/alice/bin/node', reason: '' }] }] },
    { id: 'codex', name: 'Codex CLI', files: [
      { file: '/home/alice/.codex/hooks.json', scope: 'user', rows: [{ status: 'OK' }, { status: 'STALE', reason: 'launcher at /home/alice/.zn/hooks/x.sh is old' }] },
      { file: '/work/secret-project/.codex/hooks.json', scope: 'project', rows: [{ status: 'BROKEN', reason: 'project path /work/secret-project' }] },
    ] },
    { id: 'cursor', name: 'Cursor', files: [{ file: '/home/alice/.cursor/hooks.json', scope: 'user', rows: [{ status: 'BROKEN', reason: 'broken at /home/alice' }] }] },
    { id: 'not-an-agent', name: 'Other', files: [{ file: '/x', scope: 'user', rows: [{ status: 'OK' }] }] },
  ],
  counts: { ok: 2, stale: 1, broken: 1 },
};

function machine({ answer = true, hooks = HOOKS } = {}) {
  const audit = [];
  const dialogs = [];
  const secrets = { auditKey: AUDIT_KEY, secrets: {} };
  const flags = { answer, closed: false };
  const state = {
    opts: { home: process.env.ZN_HOME },
    paths: { auditFile: path.join(process.env.ZN_HOME, 'audit.jsonl') },
    loadSecrets: async () => secrets,
    saveSecrets: async () => {},
    serial: (fn) => fn(),
  };
  const o = makeTeamOps({
    state, fetchImpl,
    writeAudit: (r) => audit.push(r),
    isClosed: () => flags.closed,
    listHooks: () => hooks,
    confirmOutOfBand: async (req) => {
      dialogs.push(req);
      if (!flags.answer) { const e = new Error('declined'); e.code = 'ZN_DECLINED'; throw e; }
    },
  });
  return { o, audit, dialogs, secrets, flags };
}

async function joined(opts) {
  const m = machine(opts);
  cloud.publishPolicy({ rules: [] });
  const r = await m.o.teamJoin({ join_token: cloud.createJoinToken({ maxUses: 20 }), api_base: cloud.base, agent: 'claude-code' });
  return { ...m, r, inst: () => cloud.state.installs.get(r.install_id) };
}

const statusRequests = () => cloud.requests.filter((q) => q.path === STATUS_PATH);

test('the body has exactly the allowed keys, from closed words, and leaves out project files and unknown agents', () => {
  const body = buildStatusBody({ version: '1.19.0', os: 'linux', policyState: 'active', policyVersion: 7, hooks: HOOKS });
  assert.deepStrictEqual(body, {
    zn_gate_version: '1.19.0', os: 'linux', policy: { version: 7, state: 'active' },
    agents: [{ id: 'claude-code', state: 'ok' }, { id: 'codex', state: 'stale' }, { id: 'cursor', state: 'broken' }],
  });
  assert.ok(isAllowedBody(body));
  assert.deepStrictEqual(Object.keys(body), ['zn_gate_version', 'os', 'policy', 'agents']);
  // The vault's words map to the report's words; anything else is "none" / "other".
  assert.strictEqual(buildStatusBody({ version: '1.19.0', os: 'win32', policyState: 'invalid', policyVersion: 3, hooks: null }).policy.state, 'refused');
  assert.strictEqual(buildStatusBody({ version: '1.19.0', os: 'plan9', policyState: 'whatever', policyVersion: -4, hooks: undefined }).os, 'other');
  assert.deepStrictEqual(buildStatusBody({ version: '1.19.0', os: 'darwin', policyState: 'none', policyVersion: undefined }).policy, { version: 0, state: 'none' });
  // A version that is not a plain version number sends nothing at all.
  assert.strictEqual(buildStatusBody({ version: '1.2.3 /home/alice', os: 'linux', policyState: 'none' }), null);
  assert.deepStrictEqual(agentsFrom({ agents: [{ id: 'zcode', files: [{ scope: 'user', rows: [{ status: 'STALE' }, { status: 'BROKEN' }] }] }] }), [{ id: 'zcode', state: 'broken' }]);
  assert.deepStrictEqual(AGENT_IDS, ['claude-code', 'codex', 'cursor', 'opencode', 'antigravity', 'copilot', 'gemini', 'zcode']);
});

test('isAllowedBody refuses extra keys, free text, paths and repeated agents', () => {
  const good = { zn_gate_version: '1.19.0', os: 'linux', policy: { version: 1, state: 'active' }, agents: [{ id: 'codex', state: 'ok' }] };
  assert.ok(isAllowedBody(good));
  const bad = [
    { ...good, host: 'laptop' }, { ...good, os: 'Linux 6.1 laptop' }, { ...good, policy: { ...good.policy, path: '/home/a' } },
    { ...good, policy: { version: 1.5, state: 'active' } }, { ...good, policy: { version: 1, state: 'fine' } },
    { ...good, agents: [{ id: 'codex', state: 'ok', file: '/home/a/.codex' }] }, { ...good, agents: [{ id: '/home/a', state: 'ok' }] },
    { ...good, agents: [{ id: 'codex', state: 'ok' }, { id: 'codex', state: 'ok' }] }, { ...good, zn_gate_version: '1.19.0\n/home/a' },
    { zn_gate_version: '1.19.0', os: 'linux', policy: good.policy }, null, [], 'text',
  ];
  for (const b of bad) assert.strictEqual(isAllowedBody(b), false, JSON.stringify(b));
});

test('privacy: the body that is sent has no path, host name, user name or environment value', async () => {
  process.env.ZN_TEST_SECRET_VALUE = 'hunter2-not-a-real-value';
  const m = await joined();
  await m.o.teamSync({});
  assert.strictEqual(statusRequests().length, 1);
  const sent = m.inst().status;
  assert.ok(isAllowedBody(sent));
  const text = JSON.stringify(sent);
  let username = '';
  try { username = os.userInfo().username; } catch { username = ''; }
  const needles = [os.homedir(), os.hostname(), username, process.env.HOME, process.env.USERPROFILE, process.env.USER, process.env.USERNAME, process.env.ZN_TEST_SECRET_VALUE, HOME, process.cwd(), '/home/alice', 'secret-project']
    .filter((v) => typeof v === 'string' && v.length >= 4);
  for (const n of needles) assert.ok(!text.includes(n), 'the body must not contain ' + n);
  assert.ok(!/[\\/]/.test(text), 'no path separator in the body');
  assert.deepStrictEqual(sent.agents, [{ id: 'claude-code', state: 'ok' }, { id: 'codex', state: 'stale' }, { id: 'cursor', state: 'broken' }]);
  assert.strictEqual(sent.policy.state, 'active');
  assert.strictEqual(sent.zn_gate_version, VERSION);
  delete process.env.ZN_TEST_SECRET_VALUE;
});

test('the join dialog lists the status report and a join turns it on', async () => {
  const m = await joined();
  const dialog = m.dialogs.find((d) => /^connect this machine/.test(d.title));
  const status = dialog.fields.find(([k]) => k === 'Status')[1];
  assert.match(status, /zn-gate version, OS/);
  assert.match(status, /policy/);
  assert.match(status, /which agents have zn hooks/);
  assert.match(status, /No paths, no names/);
  const info = await m.o.teamInfo();
  assert.strictEqual(info.status_report.on, true);
  assert.strictEqual(info.status_report.via, 'join');
  assert.strictEqual(info.status_report.last, null);
  await m.o.teamSync({});
  assert.strictEqual(statusRequests().length, 1);
  // The request carries the install token and the client header, and is the only thing sent to this endpoint.
  assert.ok(statusRequests()[0].authorized);
  assert.strictEqual(statusRequests()[0].headers['x-zn-client'], 'zn-gate/' + VERSION);
});

test('status shows the exact last body and time', async () => {
  const m = await joined();
  await m.o.teamSync({});
  const info = await m.o.teamInfo();
  const last = info.status_report.last;
  assert.strictEqual(last.ok, true);
  assert.ok(Number.isFinite(Date.parse(last.at)));
  assert.deepStrictEqual(last.body, m.inst().status, 'what status shows is what the server received');
  assert.strictEqual(last.error, null);
});

test('a machine that joined before status reports existed sends nothing until it accepts once', async () => {
  const m = await joined();
  delete m.secrets.team.status_report; // the record of an older zn-gate has no flag
  const before = statusRequests().length;
  await m.o.teamSync({});
  await m.o.teamSync({});
  assert.strictEqual(statusRequests().length, before, 'never sent without the flag');
  const off = await m.o.teamInfo();
  assert.strictEqual(off.status_report.on, false);
  assert.strictEqual(off.status_report.last, null);
  // Declining the dialog changes nothing.
  m.flags.answer = false;
  await assert.rejects(m.o.teamStatusReport({ action: 'accept' }), /declined/);
  await m.o.teamSync({});
  assert.strictEqual(statusRequests().length, before);
  assert.strictEqual((await m.o.teamInfo()).status_report.on, false);
  // One explicit acceptance, on the vault's own channel.
  m.flags.answer = true;
  const asked = m.dialogs.length;
  const r = await m.o.teamStatusReport({ action: 'accept' });
  assert.strictEqual(r.on, true);
  const dialog = m.dialogs[asked];
  assert.strictEqual(dialog.kind, 'team');
  assert.match(dialog.title, /^send a status report to organization org_/);
  assert.match(dialog.fields.find(([k]) => k === 'Sends')[1], /No paths, no names/);
  assert.strictEqual(m.dialogs.length, asked + 1);
  assert.strictEqual(statusRequests().length, before, 'accepting does not send by itself');
  await m.o.teamSync({});
  assert.strictEqual(statusRequests().length, before + 1);
  const on = await m.o.teamInfo();
  assert.strictEqual(on.status_report.on, true);
  assert.strictEqual(on.status_report.via, 'accept');
  // Accepting again asks nothing.
  const asked2 = m.dialogs.length;
  assert.strictEqual((await m.o.teamStatusReport({ action: 'accept' })).already, true);
  assert.strictEqual(m.dialogs.length, asked2);
});

test('stop turns the report off, and it stays off for later syncs', async () => {
  const m = await joined();
  await m.o.teamSync({});
  assert.strictEqual(statusRequests().length, 1);
  const r = await m.o.teamStatusReport({ action: 'stop' });
  assert.strictEqual(r.on, false);
  assert.deepStrictEqual(m.audit.at(-1), { mode: 'set', decision: 'allow', reason: 'team_status_report_off' });
  await m.o.teamSync({});
  assert.strictEqual(statusRequests().length, 1);
  assert.strictEqual((await m.o.teamInfo()).status_report.on, false);
  await assert.rejects(m.o.teamStatusReport({ action: 'maybe' }), (e) => e.code === CODES.POLICY_DENIED);
});

test('outside a team nothing is sent and the acceptance has nothing to accept', async () => {
  const m = machine();
  const before = cloud.requests.length;
  await assert.rejects(m.o.teamSync({}), (e) => e.code === CODES.NOT_FOUND);
  await assert.rejects(m.o.teamStatusReport({ action: 'accept' }), (e) => e.code === CODES.NOT_FOUND);
  assert.strictEqual(cloud.requests.length, before);
  assert.strictEqual(m.dialogs.length, 0);
  assert.deepStrictEqual(await m.o.teamInfo(), { joined: false });
});

test('after leave nothing is sent, and a new join is covered by its own dialog', async () => {
  const m = await joined();
  await m.o.teamSync({});
  assert.strictEqual(statusRequests().length, 1);
  const left = await m.o.teamLeave();
  assert.ok(left.left);
  const after = cloud.requests.length;
  await assert.rejects(m.o.teamSync({}), (e) => e.code === CODES.NOT_FOUND);
  assert.strictEqual(cloud.requests.length, after);
  assert.strictEqual(statusRequests().length, 1);
  assert.strictEqual(m.secrets.team, undefined);
  // Joining again turns it on again, because the dialog lists it again.
  const r = await m.o.teamJoin({ join_token: cloud.createJoinToken(), api_base: cloud.base, agent: 'claude-code' });
  assert.match(r.org, /^org_/);
  await m.o.teamSync({});
  assert.strictEqual(statusRequests().length, 2);
});

test('after the administrator removes the machine nothing more is sent', async () => {
  const m = await joined();
  await m.o.teamSync({});
  assert.strictEqual(statusRequests().length, 1);
  cloud.revokeInstall(m.r.install_id);
  const s = await m.o.teamSync({});
  assert.strictEqual(s.policy.status, 'revoked');
  await m.o.teamSync({});
  assert.strictEqual(statusRequests().length, 1);
});

test('the report is independent of the audit upload', async () => {
  const m = await joined();
  const s = await m.o.teamSync({ upload: false });
  assert.strictEqual(s.upload, null);
  assert.strictEqual(statusRequests().length, 1);
});

test('a server without the endpoint (404) is asked once, then again after a day or with a new version', async () => {
  cloud.setStatusMode({ status: 404, body: { error: 'Not found' } });
  const m = await joined();
  const s = await m.o.teamSync({});
  assert.strictEqual(s.policy.status, 'updated', 'the sync itself is not affected');
  assert.strictEqual(statusRequests().length, 1);
  const info = await m.o.teamInfo();
  assert.strictEqual(info.status_report.unsupported, true);
  assert.strictEqual(info.status_report.last.ok, false);
  assert.match(info.status_report.last.error, /does not take status reports yet \(HTTP 404\)/);
  await m.o.teamSync({});
  await m.o.teamSync({});
  assert.strictEqual(statusRequests().length, 1, 'not retried at every sync');
  m.secrets.team.status_report.unsupported.at = new Date(Date.now() - 2 * DAY).toISOString();
  cloud.setStatusMode(null);
  await m.o.teamSync({});
  assert.strictEqual(statusRequests().length, 2, 'asked again after a day');
  const ok = await m.o.teamInfo();
  assert.strictEqual(ok.status_report.unsupported, false);
  assert.strictEqual(ok.status_report.last.ok, true);
  // A new zn-gate version asks again at once.
  cloud.setStatusMode({ status: 405 });
  await m.o.teamSync({});
  assert.strictEqual(statusRequests().length, 3);
  m.secrets.team.status_report.unsupported.version = '0.0.1';
  await m.o.teamSync({});
  assert.strictEqual(statusRequests().length, 4);
});

test('an offline server or an error answer never fails the sync; the last good report time is kept', async () => {
  const m = await joined();
  await m.o.teamSync({});
  const good = (await m.o.teamInfo()).status_report.last.at;
  cloud.setStatusMode({ network: true });
  const s = await m.o.teamSync({});
  assert.strictEqual(s.policy.status, 'current');
  let last = (await m.o.teamInfo()).status_report.last;
  assert.strictEqual(last.ok, false);
  assert.strictEqual(last.error, 'could not reach the server');
  assert.strictEqual(last.last_ok_at, good);
  assert.ok(isAllowedBody(last.body), 'the body of the failed attempt is shown too');
  cloud.setStatusMode({ status: 500 });
  await m.o.teamSync({});
  last = (await m.o.teamInfo()).status_report.last;
  assert.match(last.error, /HTTP 500/);
  cloud.setStatusMode({ status: 429, headers: { 'Retry-After': '30' } });
  await m.o.teamSync({});
  assert.match((await m.o.teamInfo()).status_report.last.error, /HTTP 429/);
  // The whole network down: the policy step is offline, no report is tried, nothing throws.
  cloud.setStatusMode(null);
  net.throwError = true;
  const before = statusRequests().length;
  const off = await m.o.teamSync({});
  assert.strictEqual(off.policy.status, 'offline');
  assert.strictEqual(statusRequests().length, before);
});

test('a hook check that fails sends the report without agents, not an error', async () => {
  const m = machine();
  m.o = makeTeamOps({
    state: { opts: { home: process.env.ZN_HOME }, paths: { auditFile: path.join(process.env.ZN_HOME, 'audit.jsonl') }, loadSecrets: async () => m.secrets, saveSecrets: async () => {}, serial: (fn) => fn() },
    fetchImpl, writeAudit: () => {}, listHooks: () => { throw new Error('boom at /home/alice'); }, confirmOutOfBand: async () => {},
  });
  cloud.publishPolicy({ rules: [] });
  const r = await m.o.teamJoin({ join_token: cloud.createJoinToken({ maxUses: 20 }), api_base: cloud.base });
  await m.o.teamSync({});
  assert.deepStrictEqual(cloud.state.installs.get(r.install_id).status.agents, []);
});

test('the api: reportStatus never throws for an answer, and a body with the wrong shape is refused by the server', async () => {
  const m = await joined();
  const t = m.secrets.team;
  const api = createApi({ base: cloud.base, token: t.install_token, userAgent: 'zn-gate/' + VERSION });
  assert.deepStrictEqual(await api.reportStatus({ zn_gate_version: '1.19.0', os: 'linux', policy: { version: 1, state: 'active' }, agents: [] }), { done: true });
  const refused = await api.reportStatus({ zn_gate_version: '1.19.0', os: 'linux', policy: { version: 1, state: 'active' }, agents: [], host: 'laptop' });
  assert.strictEqual(refused.done, false);
  assert.strictEqual(refused.status, 400);
  const noToken = createApi({ base: cloud.base, token: 'zni_00000000-0000-0000-0000-000000000000_' + 'a'.repeat(32), userAgent: 'zn-gate/' + VERSION });
  assert.strictEqual((await noToken.reportStatus({ zn_gate_version: '1.19.0', os: 'linux', policy: { version: 1, state: 'none' }, agents: [] })).status, 401);
  cloud.setStatusMode({ status: 405 });
  const un = await api.reportStatus({ zn_gate_version: '1.19.0', os: 'linux', policy: { version: 1, state: 'none' }, agents: [] });
  assert.strictEqual(un.unsupported, true);
  cloud.setStatusMode({ status: 429, headers: { 'Retry-After': '12' } });
  assert.strictEqual((await api.reportStatus({ zn_gate_version: '1.19.0', os: 'linux', policy: { version: 1, state: 'none' }, agents: [] })).retryAfterSeconds, 12);
});
