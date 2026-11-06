'use strict';
/*
 * `zn team leave` tells the server (POST /v1/org/install/leave, the installation's own token) before it deletes
 * anything, and keeps a small pending record when the server cannot take it: retried on sync, on leave and by the
 * periodic job, with its own token only, until 200, 401 or the 30-day give-up. A pending record is not a membership.
 * The zn cloud is the local stand-in server (its leave route follows the real contract; setLeaveMode forces answers).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-team-leave-rev-'));
process.env.ZN_HOME = path.join(HOME, '.zn');

const { startFakeTeamServer } = require('./helpers/fake_team_server');
const { makeTeamOps } = require('../lib/team/daemon-ops');
const policy = require('../lib/team/policy');

const DAY = 86400000;
const AUDIT_KEY = 'ab'.repeat(32);
let cloud;

test.before(async () => { cloud = await startFakeTeamServer(); });
test.after(async () => { await cloud.close(); fs.rmSync(HOME, { recursive: true, force: true }); });
test.beforeEach(() => {
  cloud.setOrgActive(true);
  cloud.setLeaveMode(null);
  cloud.requests.length = 0;
  fs.rmSync(process.env.ZN_HOME, { recursive: true, force: true });
  fs.mkdirSync(process.env.ZN_HOME, { recursive: true });
});

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
  const o = makeTeamOps({ state, fetchImpl: fetch, writeAudit: (r) => audit.push(r), confirmOutOfBand: async () => {} });
  return { o, audit, secrets };
}

const joinOn = (m) => m.o.teamJoin({ join_token: cloud.createJoinToken({ maxUses: 20 }), api_base: cloud.base });
async function joined() {
  const m = machine();
  m.r = await joinOn(m);
  return m;
}
const leaveCalls = () => cloud.requests.filter((r) => r.path === '/v1/org/install/leave');
const pendingOf = (m) => m.secrets.pendingRevocations || [];
const serverInstall = (id) => cloud.state.installs.get(id);

test('200: the server is told before anything is deleted, with the client header; nothing stays pending', async () => {
  const m = await joined();
  cloud.publishPolicy({ rules: [] });
  await m.o.teamSync({ upload: false });
  const id = m.r.install_id;
  const out = await m.o.teamLeave();
  assert.strictEqual(out.revocation.status, 'done');
  assert.strictEqual(out.revocation.reason, 'revoked');
  assert.deepStrictEqual(out.pending_files, []);
  assert.strictEqual(leaveCalls().length, 1);
  assert.match(leaveCalls()[0].headers['x-zn-client'], /^zn-gate\/\d+\.\d+\.\d+/);
  assert.ok(leaveCalls()[0].authorized, 'the install token was sent');
  assert.strictEqual(serverInstall(id).revoked, true);
  assert.strictEqual(m.secrets.team, undefined);
  assert.strictEqual(m.secrets.pendingRevocations, undefined);
  assert.strictEqual(policy.readTeam(), null);
  assert.deepStrictEqual(m.audit.map((a) => a.reason).filter((r) => /^team_/.test(r)), ['team_joined', 'team_left']);
});

test('200 already:true and 401 both finish the leave (nothing is left to revoke)', async () => {
  const m = await joined();
  cloud.setLeaveMode({ status: 200, body: { revoked: true, already: true, install_id: m.r.install_id } });
  let out = await m.o.teamLeave();
  assert.deepStrictEqual(out.revocation, { status: 'done', reason: 'already' });
  assert.strictEqual(m.secrets.pendingRevocations, undefined);
  const m2 = await joined();
  cloud.setLeaveMode({ status: 401, body: { error: 'Missing or invalid install token' } });
  out = await m2.o.teamLeave();
  assert.deepStrictEqual(out.revocation, { status: 'done', reason: 'token_invalid' });
  assert.strictEqual(m2.secrets.pendingRevocations, undefined);
  assert.strictEqual(m2.secrets.team, undefined);
});

test('an install that an admin already removed answers 401: the leave completes', async () => {
  const m = await joined();
  cloud.revokeInstall(m.r.install_id);
  const out = await m.o.teamLeave();
  assert.strictEqual(out.revocation.reason, 'token_invalid');
  assert.strictEqual(m.secrets.pendingRevocations, undefined);
});

for (const [name, mode, why] of [
  ['5xx', { status: 503 }, /HTTP 503/],
  ['500', { status: 500 }, /HTTP 500/],
  ['network down', { network: true }, /could not reach the server/],
  ['404 (an older server without the endpoint)', { status: 404, body: { error: 'Not found' } }, /does not support leaving yet \(HTTP 404\)/],
  ['405 (an older server)', { status: 405, body: { error: 'Method not allowed' } }, /does not support leaving yet \(HTTP 405\)/],
  ['429 with Retry-After', { status: 429, headers: { 'Retry-After': '120' }, body: { code: 'rate_limited' } }, /HTTP 429/],
  ['a 200 that is not the contract', { status: 200, body: { ok: true } }, /unexpected answer/],
]) {
  test('leave when the server answers ' + name + ': the machine leaves at once, the revocation stays pending, exit-0 result', async () => {
    const m = await joined();
    cloud.publishPolicy({ rules: [] });
    await m.o.teamSync({ upload: false });
    const id = m.r.install_id;
    const tokenBefore = m.secrets.team.install_token;
    cloud.setLeaveMode(mode);
    const out = await m.o.teamLeave();
    assert.strictEqual(out.left, m.r.org);
    assert.deepStrictEqual(out.pending_files, []);
    assert.strictEqual(out.revocation.status, 'pending');
    assert.match(out.revocation.error, why);
    assert.ok(Date.parse(out.revocation.give_up_at) - Date.parse(out.revocation.since) === 30 * DAY, 'give-up is 30 days');
    // Not a membership: the Team policy and behaviour are gone at once.
    assert.strictEqual(m.secrets.team, undefined);
    assert.strictEqual(policy.readTeam(), null);
    assert.strictEqual(policy.readCache(), null);
    assert.strictEqual(m.secrets.orgApprovals, undefined);
    const info = await m.o.teamInfo();
    assert.strictEqual(info.joined, false);
    assert.strictEqual(info.revocations.length, 1);
    assert.strictEqual(info.revocations[0].install_id, id);
    assert.strictEqual(info.revocations[0].tries, 1);
    assert.ok(!JSON.stringify(info).includes(tokenBefore), 'status never shows the token');
    assert.ok(!JSON.stringify(info).includes('zni_'));
    // The record keeps only what the retry needs.
    assert.deepStrictEqual(Object.keys(pendingOf(m)[0]).sort(), ['api_base', 'install_id', 'install_token', 'last_error', 'last_try_at', 'next_try_at', 'org', 'org_name', 'since', 'tries']);
    assert.strictEqual(pendingOf(m)[0].install_token, tokenBefore);
    assert.notStrictEqual(serverInstall(id).revoked, true, 'a failed answer is never treated as revoked');
    assert.ok(m.audit.some((a) => a.reason === 'team_revocation_pending'));
    if (mode.status === 429) {
      const wait = Date.parse(pendingOf(m)[0].next_try_at) - Date.now();
      assert.ok(wait > 100000 && wait <= 120000, 'Retry-After is kept');
    } else {
      assert.strictEqual(pendingOf(m)[0].next_try_at, null);
    }
  });
}

test('a pending record is not a membership: no policy download, no upload, no detectors', async () => {
  const m = await joined();
  cloud.publishPolicy({ rules: [], detectors: [{ id: 'acme', pattern: 'ACME-[A-Z0-9]{24}', type: 'ACME_TOKEN' }] });
  await m.o.teamSync({ upload: false });
  cloud.setLeaveMode({ status: 503 });
  await m.o.teamLeave();
  cloud.requests.length = 0;
  // A sync with no organization says so and only retries the revocation: no policy or audit request.
  await assert.rejects(m.o.teamSync({}), /not in an organization.*has not yet been told that installation .* left/);
  assert.deepStrictEqual(cloud.requests.map((r) => r.path), ['/v1/org/install/leave']);
  assert.strictEqual(policy.readTeam(), null);
  const hook = await m.o.teamHookInfo();
  assert.deepStrictEqual(hook, { joined: false }, 'no detectors from a pending record');
  assert.deepStrictEqual(await m.o.effectiveList([]), []);
});

test('a retry on sync that succeeds clears the record; the server then has the installation revoked', async () => {
  const m = await joined();
  cloud.setLeaveMode({ status: 503 });
  await m.o.teamLeave();
  const id = m.r.install_id;
  assert.strictEqual(pendingOf(m).length, 1);
  assert.notStrictEqual(serverInstall(id).revoked, true);
  // Still down: the record stays, the counters move.
  cloud.setLeaveMode({ status: 500 });
  await assert.rejects(m.o.teamSync({}), /not in an organization/);
  assert.strictEqual(pendingOf(m)[0].tries, 2);
  assert.match(pendingOf(m)[0].last_error, /HTTP 500/);
  // The server is back (and now supports it).
  cloud.setLeaveMode(null);
  await assert.rejects(m.o.teamSync({}), /revocation of the installation left earlier was completed/);
  assert.strictEqual(m.secrets.pendingRevocations, undefined);
  assert.strictEqual(serverInstall(id).revoked, true);
  assert.ok(m.audit.some((a) => a.reason === 'team_revocation_done'));
  // Nothing pending any more: a sync outside an organization is the plain error again.
  await assert.rejects(m.o.teamSync({}), (e) => /^this machine is not in an organization \(zn team join <token>\)$/.test(e.message));
});

test('a 429 is not retried before its Retry-After; the periodic sync of a member retries what is due', async () => {
  const m = await joined();
  cloud.setLeaveMode({ status: 429, headers: { 'Retry-After': '3600' } });
  await m.o.teamLeave();
  cloud.setLeaveMode(null);
  cloud.requests.length = 0;
  await assert.rejects(m.o.teamSync({}), /not in an organization/);
  assert.strictEqual(leaveCalls().length, 0, 'not due yet');
  pendingOf(m)[0].next_try_at = new Date(Date.now() - 1000).toISOString();
  await assert.rejects(m.o.teamSync({}), /completed/);
  assert.strictEqual(leaveCalls().length, 1);
  assert.strictEqual(m.secrets.pendingRevocations, undefined);
});

test('re-join while a revocation is pending: the OLD record is retried with the OLD token, never the new one', async () => {
  const m = await joined();
  const oldId = m.r.install_id;
  const oldToken = m.secrets.team.install_token;
  cloud.setLeaveMode({ status: 503 });
  await m.o.teamLeave();
  cloud.setLeaveMode(null);
  const again = await joinOn(m);
  assert.notStrictEqual(again.install_id, oldId, 'a new installation');
  const newToken = m.secrets.team.install_token;
  assert.notStrictEqual(newToken, oldToken);
  cloud.publishPolicy({ rules: [] });
  const s = await m.o.teamSync({ upload: false });
  assert.strictEqual(s.policy.status, 'updated');
  assert.deepStrictEqual(s.revocations, { tried: 1, done: 1, pending: 0, abandoned: 0 });
  assert.strictEqual(serverInstall(oldId).revoked, true, 'the old installation was revoked with its own token');
  assert.notStrictEqual(serverInstall(again.install_id).revoked, true, 'the new membership is untouched');
  assert.strictEqual(m.secrets.team.install_token, newToken, 'and still in the vault');
  assert.strictEqual(m.secrets.pendingRevocations, undefined);
  // The record of the old membership never carried the new token.
  const m2 = await joined();
  const t1 = m2.secrets.team.install_token;
  cloud.setLeaveMode({ status: 503 });
  await m2.o.teamLeave();
  cloud.setLeaveMode(null);
  await joinOn(m2);
  assert.strictEqual(pendingOf(m2)[0].install_token, t1);
  assert.notStrictEqual(pendingOf(m2)[0].install_token, m2.secrets.team.install_token);
  // The new membership is not changed by the pending list (generation, policy, copies).
  assert.ok(m2.secrets.team.gen > 1);
});

test('leaving a second time also retries the revocation of an earlier membership', async () => {
  const m = await joined();
  const firstId = m.r.install_id;
  cloud.setLeaveMode({ status: 503 });
  await m.o.teamLeave();
  cloud.setLeaveMode(null);
  const second = await joinOn(m);
  const out = await m.o.teamLeave();
  assert.strictEqual(out.revocation.status, 'done');
  assert.strictEqual(serverInstall(firstId).revoked, true);
  assert.strictEqual(serverInstall(second.install_id).revoked, true);
  assert.strictEqual(m.secrets.pendingRevocations, undefined);
  assert.strictEqual(leaveCalls().length, 3, 'one failed, then the second leave and the retry of the first');
  // Leave with no organization retries what is pending as well and reports it.
  const m2 = await joined();
  cloud.setLeaveMode({ status: 503 });
  await m2.o.teamLeave();
  const none = await m2.o.teamLeave();
  assert.strictEqual(none.left, null);
  assert.strictEqual(none.revocations.length, 1);
  assert.match(none.revocations[0].last_error, /HTTP 503/);
  assert.strictEqual(m2.secrets.pendingRevocations[0].tries, 2);
  cloud.setLeaveMode(null);
  const done = await m2.o.teamLeave();
  assert.deepStrictEqual(done, { left: null, pending_files: [] });
  assert.strictEqual(m2.secrets.pendingRevocations, undefined);
});

test('give-up: a record older than 30 days is dropped without asking the server; one of 29 days is still retried', async () => {
  const m = await joined();
  cloud.setLeaveMode({ status: 503 });
  await m.o.teamLeave();
  cloud.setLeaveMode({ status: 503 });
  pendingOf(m)[0].since = new Date(Date.now() - 29 * DAY).toISOString();
  cloud.requests.length = 0;
  await assert.rejects(m.o.teamSync({}), /not in an organization/);
  assert.strictEqual(leaveCalls().length, 1, '29 days: still retried');
  assert.strictEqual(pendingOf(m).length, 1);
  assert.ok((await m.o.teamInfo()).revocations[0].give_up_at, 'status says when it stops');
  pendingOf(m)[0].since = new Date(Date.now() - 31 * DAY).toISOString();
  cloud.requests.length = 0;
  await assert.rejects(m.o.teamSync({}), /not in an organization/);
  assert.strictEqual(leaveCalls().length, 0, '31 days: no request');
  assert.strictEqual(m.secrets.pendingRevocations, undefined);
  assert.ok(m.audit.some((a) => a.reason === 'team_revocation_abandoned'));
  assert.deepStrictEqual(await m.o.teamInfo(), { joined: false });
});

test('a leave of the same installation twice keeps one record; at most 8 are kept', async () => {
  const m = machine();
  for (let i = 0; i < 10; i += 1) {
    await joinOn(m);
    cloud.setLeaveMode({ status: 503 });
    await m.o.teamLeave();
  }
  assert.strictEqual(pendingOf(m).length, 8);
  assert.strictEqual(new Set(pendingOf(m).map((r) => r.install_id)).size, 8);
});

test('a membership change during the leave call is refused and nothing is deleted', async () => {
  const m = await joined();
  const t = m.secrets.team;
  const swapper = makeTeamOps({
    state: { opts: { home: process.env.ZN_HOME }, paths: { auditFile: path.join(process.env.ZN_HOME, 'a.jsonl') }, loadSecrets: async () => m.secrets, saveSecrets: async () => {}, serial: (fn) => fn() },
    // Someone else changes the membership while the server is being asked.
    fetchImpl: async (url, init) => { m.secrets.team = { ...t, gen: t.gen + 1 }; return fetch(url, init); },
    writeAudit: () => {}, confirmOutOfBand: async () => {},
  });
  await assert.rejects(swapper.teamLeave(), /membership changed while leaving/);
  assert.ok(m.secrets.team, 'still a member of the newer membership');
});
