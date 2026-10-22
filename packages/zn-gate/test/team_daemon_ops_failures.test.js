'use strict';
/*
 * The zn Team operations of the vault daemon (lib/team/daemon-ops.js): the
 * failure paths a user can hit on their own machine, and the message each one
 * gives. Join, leave and info are the "start, stop and status" of an
 * organization connection.
 *
 * Covered here (the other edges are in team_daemon_ops_edges.test.js):
 *   - the server address refuses connections (nothing listens on the port);
 *   - the state directory is missing, is a file, or cannot be written;
 *   - stale or damaged copies under ~/.zn (team.json, org-policy.json);
 *   - every refusal message is plain text with a next step, never a stack
 *     trace, an object dump or an unfilled value.
 *
 * Everything runs against 127.0.0.1 stand-ins, in temporary folders. HOME and
 * the other home variables point to a temporary folder, so nothing under the
 * real home is read or written.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zn-team-ops-fail-')));
process.env.HOME = ROOT;
process.env.USERPROFILE = ROOT;
process.env.XDG_CONFIG_HOME = path.join(ROOT, 'config');
process.env.ZN_HOME = path.join(ROOT, '.zn');

const { startFakeTeamServer } = require('./helpers/fake_team_server');
const { makeTeamOps } = require('../lib/team/daemon-ops');
const policy = require('../lib/team/policy');
const { CODES } = require('../lib/errors');

const AUDIT_KEY = 'ab'.repeat(32);
const IS_WIN = process.platform === 'win32';
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;
const NO_CHMOD = IS_WIN ? 'chmod does not make a directory read-only on Windows' : IS_ROOT ? 'root ignores directory permissions' : false;
let cloud;

test.before(async () => { cloud = await startFakeTeamServer(); });
test.after(async () => { await cloud.close(); fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });
test.beforeEach(() => {
  cloud.setOrgActive(true);
  fs.rmSync(process.env.ZN_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  fs.mkdirSync(process.env.ZN_HOME, { recursive: true });
});

/** A port on 127.0.0.1 that nothing listens on: bind, note the port, close. */
function closedPort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** One machine: in-memory vault, real fetch, dialogs approved. */
function machine() {
  const audit = [];
  const secrets = { auditKey: AUDIT_KEY, secrets: {} };
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

/** A user-facing message is plain text: no stack, no object dump, no unfilled value. */
function assertPlain(message) {
  assert.strictEqual(typeof message, 'string');
  assert.ok(message.length > 10 && message.length < 400, 'short enough to read: ' + message.length);
  assert.ok(!/\n\s+at /.test(message), 'no stack trace');
  assert.ok(!/\[object |undefined|NaN/.test(message), 'no unfilled value: ' + message);
  assert.ok(!message.includes(ROOT), 'no temporary path');
}

async function refusal(promise) {
  try { await promise; } catch (e) { return e; }
  return assert.fail('expected a refusal');
}

test('an address that refuses connections: join says so, stores nothing, audits the refusal', async () => {
  const port = await closedPort();
  const m = machine();
  const seen = cloud.requests.length;
  const e = await refusal(m.o.teamJoin({ join_token: cloud.createJoinToken(), api_base: 'http://127.0.0.1:' + port }));
  assert.strictEqual(e.code, CODES.POLICY_DENIED);
  assertPlain(e.message);
  assert.strictEqual(e.message, 'join failed (ZN_TEAM_NETWORK). This machine was not connected.');
  assert.strictEqual(cloud.requests.length, seen + 0, 'the other server was not contacted');
  assert.strictEqual(m.secrets.team, undefined);
  assert.strictEqual(policy.readTeam(), null);
  assert.deepStrictEqual(m.audit, [{ mode: 'set', decision: 'deny', reason: 'team_join_failed' }]);
});

test('an address that refuses connections: sync is offline, not an error, and keeps the held state', async () => {
  const m = machine();
  const j = await m.o.teamJoin({ join_token: cloud.createJoinToken(), api_base: cloud.base });
  m.secrets.team.api_base = 'http://127.0.0.1:' + await closedPort();
  const s = await m.o.teamSync({});
  assert.deepStrictEqual(s.policy, { status: 'offline', error: 'ZN_TEAM_NETWORK' });
  assert.ok(m.secrets.team, 'still joined');
  assert.strictEqual(m.secrets.team.install_id, j.install_id);
  const info = await m.o.teamInfo();
  assert.strictEqual(info.joined, true);
  assert.strictEqual(info.revoked_at, null, 'being offline is not a revocation');
});

test('a missing state directory is created by join, and leave and info work without one', async () => {
  fs.rmSync(process.env.ZN_HOME, { recursive: true, force: true });
  const m = machine();
  assert.deepStrictEqual(await m.o.teamInfo(), { joined: false });
  assert.deepStrictEqual(await m.o.teamLeave(), { left: null });
  const r = await m.o.teamJoin({ join_token: cloud.createJoinToken(), api_base: cloud.base });
  assert.ok(fs.statSync(process.env.ZN_HOME).isDirectory());
  assert.strictEqual(policy.readTeam().install_id, r.install_id);
  if (!IS_WIN) assert.strictEqual(fs.statSync(policy.paths().teamFile).mode & 0o077, 0, 'team.json is private');
});

test('the state directory is a file: info and leave still answer, join fails', async (t) => {
  fs.rmSync(process.env.ZN_HOME, { recursive: true, force: true });
  fs.writeFileSync(process.env.ZN_HOME, 'not a directory');
  t.after(() => fs.rmSync(process.env.ZN_HOME, { force: true }));
  const m = machine();
  assert.deepStrictEqual(await m.o.teamInfo(), { joined: false });
  assert.deepStrictEqual(await m.o.teamLeave(), { left: null });
  const e = await refusal(m.o.teamJoin({ join_token: cloud.createJoinToken(), api_base: cloud.base }));
  // Current behaviour, pinned: the raw file-system error, not a zn message with a next step.
  assert.match(String(e.code), /^(EEXIST|ENOTDIR|EPERM|EACCES)$/);
  assert.ok(!/join failed/.test(e.message));
});

test('the state directory cannot be written: join fails after the vault was saved', { skip: NO_CHMOD }, async (t) => {
  const m = machine();
  fs.chmodSync(process.env.ZN_HOME, 0o500);
  t.after(() => { try { fs.chmodSync(process.env.ZN_HOME, 0o700); } catch (e) { /* already removed */ } });
  const e = await refusal(m.o.teamJoin({ join_token: cloud.createJoinToken(), api_base: cloud.base }));
  assert.strictEqual(e.code, 'EACCES');
  // Current behaviour, pinned: the vault holds the organization, the readable copy for the hooks is missing.
  assert.ok(m.secrets.team);
  assert.strictEqual(policy.readTeam(), null);
});

test('a policy that cannot be copied to disk: sync throws the raw system error', { skip: NO_CHMOD }, async (t) => {
  const m = machine();
  await m.o.teamJoin({ join_token: cloud.createJoinToken(), api_base: cloud.base });
  cloud.publishPolicy({ rules: [] });
  fs.chmodSync(process.env.ZN_HOME, 0o500);
  t.after(() => { try { fs.chmodSync(process.env.ZN_HOME, 0o700); } catch (e) { /* already removed */ } });
  // Current behaviour, pinned (board B-932): the disk error escapes sync as a raw EACCES, with no next step,
  // although the policy was downloaded and kept in the vault.
  const e = await refusal(m.o.teamSync({ upload: false }));
  assert.strictEqual(e.code, 'EACCES');
  assert.ok(m.secrets.team.policy, 'the vault did keep the downloaded policy');
});

test('stale or damaged copies under the state directory do not change what status reports', async () => {
  const m = machine();
  const r = await m.o.teamJoin({ join_token: cloud.createJoinToken(), api_base: cloud.base });
  cloud.publishPolicy({ rules: [] });
  await m.o.teamSync({ upload: false });
  const f = policy.paths();
  for (const damage of ['', '{', '[]', 'null', '{"v":2}', '\u0000\u0000', '{"v":1,"org":"x"}']) {
    fs.writeFileSync(f.teamFile, damage);
    fs.writeFileSync(f.policyFile, damage);
    const info = await m.o.teamInfo();
    assert.strictEqual(info.joined, true, JSON.stringify(damage));
    assert.strictEqual(info.install_id, r.install_id);
    assert.strictEqual(info.policy.state, 'active');
  }
  // Sync puts the readable policy copy back from the vault.
  const s = await m.o.teamSync({ upload: false });
  assert.strictEqual(s.policy.status, 'current');
  assert.strictEqual(policy.readCache().envelope.policy.version, cloud.state.policyVersion);
});

test('leave with no organization removes damaged and stale copies, and a second leave is harmless', async () => {
  const m = machine();
  const f = policy.paths();
  fs.writeFileSync(f.teamFile, '{ truncated');
  fs.writeFileSync(f.policyFile, '\u0000');
  fs.writeFileSync(f.uploadState, 'x');
  assert.deepStrictEqual(await m.o.teamLeave(), { left: null });
  for (const k of ['teamFile', 'policyFile', 'uploadState']) assert.ok(!fs.existsSync(f[k]), k);
  assert.deepStrictEqual(await m.o.teamLeave(), { left: null });
});

test('leave in an organization works even when a readable copy is already gone', async () => {
  const m = machine();
  const r = await m.o.teamJoin({ join_token: cloud.createJoinToken(), api_base: cloud.base });
  fs.rmSync(policy.paths().teamFile);
  const out = await m.o.teamLeave();
  assert.strictEqual(out.left, r.org);
  assert.strictEqual(m.secrets.team, undefined);
  assert.deepStrictEqual(await m.o.teamInfo(), { joined: false });
});

test('every refusal a user can hit gives a plain message with a next step', async () => {
  const m = machine();
  const port = await closedPort();
  const tok = 'znj_' + 'a'.repeat(40);
  const msgs = [];
  const grab = async (p) => { msgs.push((await refusal(p)).message); };

  await grab(m.o.teamJoin({ join_token: 'nope' }));
  await grab(m.o.teamJoin({ join_token: tok, api_base: 'http://team.example.com' }));
  await grab(m.o.teamJoin({ join_token: tok, api_base: 'http://127.0.0.1:' + port }));
  cloud.setOrgActive(false);
  await grab(m.o.teamJoin({ join_token: cloud.createJoinToken(), api_base: cloud.base }));
  cloud.setOrgActive(true);
  await grab(m.o.teamSync({}));
  await grab(m.o.confirmOrgOpening('A_B', 'host', 'x.example.com', 'codex', true));
  await grab(m.o.confirmOrgOpening('bad name', 'host', 'x.example.com', 'codex', true));
  await m.o.teamJoin({ join_token: cloud.createJoinToken(), api_base: cloud.base });
  await grab(m.o.teamJoin({ join_token: cloud.createJoinToken(), api_base: cloud.base.replace('127.0.0.1', 'localhost') }));

  assert.strictEqual(msgs.length, 8);
  for (const msg of msgs) assertPlain(msg);
  // Each one says what to do, or that nothing was changed.
  const next = /(Copy it again|administrator|zn team join|zn team leave|zn team status|not connected|nothing was approved|invalid API address|no active Team)/i;
  for (const msg of msgs) assert.match(msg, next, msg);
});
