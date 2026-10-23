'use strict';
/*
 * The zn Team operations of the vault daemon (lib/team/daemon-ops.js) in the
 * cases the end-to-end tests do not reach: refused arguments, joins that fail
 * or change organization, offline and revoked installations, an expired or
 * tampered policy, a server that sends a bad answer, and the approval of a
 * host the policy opens. The zn cloud is the local stand-in server.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-team-ops-edges-'));
process.env.ZN_HOME = path.join(HOME, '.zn');

const { startFakeTeamServer, makeAuditChain } = require('./helpers/fake_team_server');
const { makeTeamOps } = require('../lib/team/daemon-ops');
const policy = require('../lib/team/policy');
const { approvalKey } = require('../lib/team/effective');
const { CODES } = require('../lib/errors');

const DAY = 86400000;
const AUDIT_KEY = 'ab'.repeat(32);
let cloud;
let net;

test.before(async () => { cloud = await startFakeTeamServer(); });
test.after(async () => { await cloud.close(); fs.rmSync(HOME, { recursive: true, force: true }); });
test.beforeEach(() => {
  net = { throwError: false, status: 0, rewriteJoin: null, afterPolicy: null };
  cloud.setOrgActive(true);
  fs.rmSync(process.env.ZN_HOME, { recursive: true, force: true });
  fs.mkdirSync(process.env.ZN_HOME, { recursive: true });
});

async function fetchImpl(url, init) {
  if (net.throwError) throw new TypeError('fetch failed');
  if (net.status) return new Response('{"error":"simulated failure"}', { status: net.status, headers: { 'content-type': 'application/json' } });
  const res = await fetch(url, init);
  if (net.afterPolicy && String(url).endsWith('/v1/org/policy')) net.afterPolicy();
  if (net.rewriteJoin && String(url).endsWith('/v1/org/join')) {
    const body = JSON.parse(await res.text());
    net.rewriteJoin(body);
    return new Response(JSON.stringify(body), { status: res.status, headers: { 'content-type': 'application/json' } });
  }
  return res;
}

/** One machine: in-memory vault state, the audit log in a temp file, dialogs recorded. */
function machine({ answer = true, closed = false } = {}) {
  const audit = [];
  const dialogs = [];
  const secrets = { auditKey: AUDIT_KEY, secrets: {} };
  const auditFile = path.join(process.env.ZN_HOME, 'audit.jsonl');
  const flags = { closed, answer };
  const state = {
    opts: { home: process.env.ZN_HOME },
    paths: { auditFile },
    loadSecrets: async () => secrets,
    saveSecrets: async () => {},
    serial: (fn) => fn(),
  };
  const o = makeTeamOps({
    state, fetchImpl,
    writeAudit: (r) => audit.push(r),
    isClosed: () => flags.closed,
    confirmOutOfBand: async (req) => {
      dialogs.push(req);
      if (!flags.answer) { const e = new Error('declined'); e.code = 'ZN_DECLINED'; throw e; }
    },
  });
  return { o, audit, dialogs, secrets, flags, auditFile };
}

/** Joins with the dialog approved, then applies the options (e.g. a user who declines from now on). */
async function joined({ answer = true, closed = false } = {}) {
  const m = machine();
  const r = await m.o.teamJoin({ join_token: cloud.createJoinToken({ maxUses: 20 }), api_base: cloud.base, agent: 'claude-code' });
  m.flags.answer = answer;
  m.flags.closed = closed;
  return { ...m, r };
}

test('arguments that are not a join token or a safe address are refused before anything is sent', async () => {
  const m = machine();
  const seen = cloud.requests.length;
  for (const args of [undefined, null, 'text', {}, { join_token: 'znj_short' }, { join_token: 'zni_' + 'a'.repeat(40) }, { join_token: 'znj_' + '!'.repeat(40) }]) {
    await assert.rejects(m.o.teamJoin(args), (e) => e.code === CODES.POLICY_DENIED && /invalid join token/.test(e.message));
  }
  const token = 'znj_' + 'a'.repeat(40);
  for (const api_base of ['http://team.example.com', 'ftp://team.example.com', 'https://user:pw@team.example.com', 'https://team.example.com/path', 'https://team.example.com/?x=1', 'not a url']) {
    await assert.rejects(m.o.teamJoin({ join_token: token, api_base }), (e) => e.code === CODES.POLICY_DENIED && /^invalid API address: /.test(e.message), api_base);
  }
  assert.strictEqual(cloud.requests.length, seen, 'nothing reached the server');
  assert.strictEqual(m.dialogs.length, 0);
});

test('a join the server refuses or cannot answer is reported with its reason and audited', async () => {
  const m = machine();
  cloud.setOrgActive(false);
  await assert.rejects(m.o.teamJoin({ join_token: cloud.createJoinToken(), api_base: cloud.base }), /join failed \(HTTP 402: This organization has no active Team subscription\)/);
  assert.deepStrictEqual(m.audit.at(-1), { mode: 'set', decision: 'deny', reason: 'team_join_failed' });
  cloud.setOrgActive(true);
  await assert.rejects(m.o.teamJoin({ join_token: 'znj_' + 'Z'.repeat(40), api_base: cloud.base }), /join failed \(HTTP 403: This join token is invalid, expired or used up\)/);
  net.status = 500;
  await assert.rejects(m.o.teamJoin({ join_token: cloud.createJoinToken(), api_base: cloud.base }), /join failed \(HTTP 500: simulated failure\)/);
  net.status = 0;
  net.throwError = true;
  await assert.rejects(m.o.teamJoin({ join_token: cloud.createJoinToken(), api_base: cloud.base }), /join failed \(ZN_TEAM_NETWORK\)/);
  assert.strictEqual(m.secrets.team, undefined, 'nothing was stored');
});

test('an invalid agent id is dropped, and a server that is not api.usezn.com is flagged in the dialog', async () => {
  const m = machine();
  const before = cloud.requests.length;
  const r = await m.o.teamJoin({ join_token: cloud.createJoinToken(), api_base: cloud.base, agent: 'Not A Valid Agent!' });
  assert.match(r.org, /^org_/);
  const host = new URL(cloud.base).host;
  assert.ok(m.dialogs[0].warnings.some((w) => w.includes('not the zn service') && w.includes(host)));
  assert.ok(cloud.requests.slice(before).some((q) => q.path === '/v1/org/join'));
  const inst = [...cloud.state.installs.values()].find((i) => i.installId === r.install_id);
  assert.strictEqual(inst.agent, undefined);
});

test('a server that sends an invalid signing key is refused and nothing is stored', async () => {
  const m = machine();
  net.rewriteJoin = (body) => { body.policy_public_key.kid = '0123456789abcdef'; };
  await assert.rejects(m.o.teamJoin({ join_token: cloud.createJoinToken(), api_base: cloud.base }), /the server sent an invalid organization key/);
  assert.strictEqual(m.secrets.team, undefined);
  assert.strictEqual(policy.readTeam(), null);
});

test('joining again keeps the installation, and a change of server, organization or key is refused', async () => {
  const m = await joined();
  const first = m.r;
  assert.strictEqual(policy.readTeam().install_id, first.install_id);
  const joinedAt = m.secrets.team.joined_at;

  const again = await m.o.teamJoin({ join_token: cloud.createJoinToken(), api_base: cloud.base });
  assert.strictEqual(again.install_id, first.install_id);
  assert.strictEqual(m.secrets.team.joined_at, joinedAt);
  assert.match(m.dialogs.at(-1).title, /^reconnect this machine to organization /);
  assert.deepStrictEqual(m.audit.at(-1), { mode: 'set', decision: 'allow', reason: 'team_rejoined' });

  const other = cloud.base.replace('127.0.0.1', 'localhost');
  await assert.rejects(m.o.teamJoin({ join_token: cloud.createJoinToken(), api_base: other }), /this machine is already in organization org_.* run `zn team leave` first/);

  const realOrg = m.secrets.team.org;
  m.secrets.team.org = 'org_SomethingElse1234';
  await assert.rejects(m.o.teamJoin({ join_token: cloud.createJoinToken(), api_base: cloud.base }), /the token is for another organization/);
  m.secrets.team.org = realOrg;

  const realKid = m.secrets.team.pin.kid;
  m.secrets.team.pin = { ...m.secrets.team.pin, kid: 'fedcba9876543210' };
  await assert.rejects(m.o.teamJoin({ join_token: cloud.createJoinToken(), api_base: cloud.base }), /the organization's signing key changed/);
  m.secrets.team.pin.kid = realKid;
});

test('leave without an organization removes stale copies; leave in an organization needs the dialog', async () => {
  const stale = machine();
  policy.writeTeam({ org: 'org_Stale123456789', api_base: cloud.base, install_id: 'x', policy_public_key: { alg: 'Ed25519', kid: '0'.repeat(16), key: 'A'.repeat(43) } });
  fs.writeFileSync(policy.paths().uploadState, '{}');
  fs.writeFileSync(policy.paths().policyFile, '{}');
  assert.deepStrictEqual(await stale.o.teamLeave(), { left: null, pending_files: [] });
  for (const f of ['teamFile', 'policyFile', 'uploadState']) assert.ok(!fs.existsSync(policy.paths()[f]), f);
  assert.strictEqual(stale.dialogs.length, 0);

  const declined = await joined({ answer: true });
  const refuser = makeTeamOps({
    state: { opts: { home: process.env.ZN_HOME }, paths: declined.o && { auditFile: declined.auditFile }, loadSecrets: async () => declined.secrets, saveSecrets: async () => {}, serial: (fn) => fn() },
    fetchImpl, writeAudit: () => {}, confirmOutOfBand: async () => { throw new Error('declined'); },
  });
  await assert.rejects(refuser.teamLeave(), /declined/);
  assert.ok(declined.secrets.team, 'still joined');

  declined.secrets.orgApprovals = { x: 1 };
  const out = await declined.o.teamLeave();
  assert.match(out.left, /^org_/);
  assert.strictEqual(declined.secrets.team, undefined);
  assert.strictEqual(declined.secrets.orgApprovals, undefined);
  assert.deepStrictEqual(declined.audit.at(-1), { mode: 'remove', decision: 'allow', reason: 'team_left' });
  assert.strictEqual(policy.readTeam(), null);
});

/** Appends `count` correctly chained records (MACs under AUDIT_KEY) to the machine's audit log; returns them. */
function addRecords(m, count) {
  const old = fs.existsSync(m.auditFile) ? fs.readFileSync(m.auditFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const last = old.at(-1);
  const recs = makeAuditChain({ key: AUDIT_KEY, count, startSeq: last ? last.seq + 1 : 1, prev: last ? last.mac : undefined });
  fs.appendFileSync(m.auditFile, recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return recs;
}
const uploadedSeqs = (r) => [...cloud.state.installs.get(r.install_id).events.map((e) => e.seq)];

test('join sends only the records written since joining; the earlier audit log stays on the machine', async () => {
  const m = machine();
  addRecords(m, 5); // history: written before joining
  const r = await m.o.teamJoin({ join_token: cloud.createJoinToken(), api_base: cloud.base, agent: 'claude-code' });
  const shares = m.dialogs[0].fields.find(([k]) => k === 'Shares')[1];
  assert.match(shares, /written from now on/);
  assert.match(shares, /already on this machine stay here/);
  assert.ok(!m.dialogs[0].warnings.some((w) => /already on this machine too/.test(w)));
  assert.strictEqual(m.secrets.team.upload_after_seq, 5);
  assert.strictEqual(m.secrets.team.upload_history, 'since_join');
  assert.strictEqual(policy.readTeam().upload_after_seq, 5, 'the readable copy carries the floor for `zn team status`');
  cloud.publishPolicy({ rules: [] });
  let s = await m.o.teamSync({});
  assert.strictEqual(s.upload.status, 'nothing', 'the five older records are not sent');
  assert.deepStrictEqual(uploadedSeqs(r), []);
  assert.strictEqual(s.upload.pending, 0);
  addRecords(m, 3); // written after joining
  s = await m.o.teamSync({});
  assert.strictEqual(s.upload.status, 'ok');
  assert.deepStrictEqual(uploadedSeqs(r), [6, 7, 8]);
  assert.strictEqual((await m.o.teamInfo()).upload_after_seq, 5);
});

test('join with the history flag asks for it in the dialog and sends the whole audit log', async () => {
  const m = machine();
  addRecords(m, 4);
  const r = await m.o.teamJoin({ join_token: cloud.createJoinToken(), api_base: cloud.base, include_history: true });
  assert.ok(m.dialogs[0].warnings.some((w) => /send the audit records already on this machine too/.test(w)));
  assert.match(m.dialogs[0].fields.find(([k]) => k === 'Shares')[1], /including the ones already on this machine/);
  assert.strictEqual(m.secrets.team.upload_after_seq, 0);
  assert.strictEqual(m.secrets.team.upload_history, 'included');
  cloud.publishPolicy({ rules: [] });
  await m.o.teamSync({});
  assert.deepStrictEqual(uploadedSeqs(r), [1, 2, 3, 4]);
  // Anything other than a true boolean is not consent.
  const other = machine();
  fs.rmSync(other.auditFile, { force: true }); // a different machine: its own log
  addRecords(other, 2);
  const r2 = await other.o.teamJoin({ join_token: cloud.createJoinToken(), api_base: cloud.base, include_history: 'yes' });
  assert.strictEqual(other.secrets.team.upload_after_seq, 2);
  assert.ok(r2.install_id);
});

test('rejoining keeps the choice made at the first join; history cannot be added later; a machine that joined before the choice existed keeps sending everything', async () => {
  const m = machine();
  addRecords(m, 3);
  const first = await m.o.teamJoin({ join_token: cloud.createJoinToken(), api_base: cloud.base });
  addRecords(m, 2);
  await m.o.teamJoin({ join_token: cloud.createJoinToken(), api_base: cloud.base });
  assert.strictEqual(m.secrets.team.upload_after_seq, 3, 'the floor does not move on a rejoin');
  assert.match(m.dialogs.at(-1).fields.find(([k]) => k === 'Shares')[1], /already on this machine stay here/);
  await assert.rejects(m.o.teamJoin({ join_token: cloud.createJoinToken(), api_base: cloud.base, include_history: true }), /cannot be added now.*Run `zn team leave` and join again with --include-history/);
  assert.strictEqual(m.secrets.team.upload_after_seq, 3);
  // A machine joined by an older zn-gate has neither field: everything stays uploadable, as it was agreed then.
  delete m.secrets.team.upload_after_seq;
  delete m.secrets.team.upload_history;
  await m.o.teamJoin({ join_token: cloud.createJoinToken(), api_base: cloud.base });
  assert.strictEqual(m.secrets.team.upload_after_seq, 0);
  assert.match(m.dialogs.at(-1).fields.find(([k]) => k === 'Shares')[1], /including the ones already on this machine/);
  cloud.publishPolicy({ rules: [] });
  await m.o.teamSync({});
  assert.deepStrictEqual(uploadedSeqs(first), [1, 2, 3, 4, 5]);
});

test('an unreadable audit log stops the join before anything is sent', async () => {
  const m = machine();
  fs.mkdirSync(m.auditFile, { recursive: true }); // a directory where the log should be
  const seen = cloud.requests.length;
  await assert.rejects(m.o.teamJoin({ join_token: cloud.createJoinToken(), api_base: cloud.base }), /could not read the local audit log.*not connected/);
  assert.strictEqual(m.secrets.team, undefined);
  assert.ok(!cloud.requests.slice(seen).some((q) => q.path === '/v1/org/join'), 'no join request');
});

test('leave deletes every local copy and the upload lock; one that cannot be deleted is reported by name', async () => {
  const m = await joined();
  cloud.publishPolicy({ rules: [] });
  await m.o.teamSync({ upload: false });
  const f = policy.paths();
  fs.writeFileSync(f.uploadState, '{}');
  fs.writeFileSync(f.uploadLock, '1 now\n');
  for (const k of ['teamFile', 'policyFile', 'uploadState', 'uploadLock']) assert.ok(fs.existsSync(f[k]), k);
  let out = await m.o.teamLeave();
  assert.deepStrictEqual(out.pending_files, []);
  assert.strictEqual(out.install_id, m.r.install_id);
  for (const k of ['teamFile', 'policyFile', 'uploadState', 'uploadLock']) assert.ok(!fs.existsSync(f[k]), k + ' is gone');
  assert.strictEqual(m.secrets.team, undefined, 'the vault no longer holds the organization');

  // A copy that cannot be deleted (a directory stands in its place): leave still ends the membership, and names the file.
  const m2 = await joined();
  cloud.publishPolicy({ rules: [] });
  await m2.o.teamSync({ upload: false });
  fs.rmSync(f.policyFile);
  fs.mkdirSync(path.join(f.policyFile, 'keep'), { recursive: true });
  fs.mkdirSync(path.join(f.uploadLock, 'keep'), { recursive: true });
  out = await m2.o.teamLeave();
  assert.match(out.left, /^org_/);
  assert.deepStrictEqual([...out.pending_files].sort(), [f.policyFile, f.uploadLock].sort());
  assert.ok(!fs.existsSync(f.teamFile), 'the copies that could be deleted are gone');
  assert.strictEqual(m2.secrets.team, undefined);

  // Same check on a machine that is not in an organization any more but still has a stale copy.
  const stale = machine();
  fs.rmSync(f.policyFile, { recursive: true, force: true });
  fs.rmSync(f.uploadLock, { recursive: true, force: true });
  fs.mkdirSync(path.join(f.uploadState, 'keep'), { recursive: true });
  assert.deepStrictEqual(await stale.o.teamLeave(), { left: null, pending_files: [f.uploadState] });
});

test('teamInfo says not joined, then describes the organization without the token', async () => {
  const m = machine();
  assert.deepStrictEqual(await m.o.teamInfo(), { joined: false });
  const j = await joined();
  const info = await j.o.teamInfo();
  assert.strictEqual(info.joined, true);
  assert.strictEqual(info.api_base, cloud.base);
  assert.strictEqual(info.policy.state, 'none');
  assert.strictEqual(info.revoked_at, null);
  assert.ok(!JSON.stringify(info).includes('zni_'), 'no install token');
});

test('sync on a machine that is not in an organization says so', async () => {
  const m = machine();
  await assert.rejects(m.o.teamSync({}), (e) => e.code === CODES.NOT_FOUND && /not in an organization/.test(e.message));
});

test('sync: no policy published, then a download, then "still current" refreshes the copy', async () => {
  const m = await joined();
  cloud.state.policyVersion = 0;
  let s = await m.o.teamSync({ upload: false });
  assert.deepStrictEqual(s, { policy: { status: 'none' }, upload: null });
  cloud.publishPolicy({ rules: [{ secret: 'PROD_*', agents: ['*'], deny: true }] });
  s = await m.o.teamSync({ upload: false });
  assert.strictEqual(s.policy.status, 'updated');
  assert.ok(m.audit.some((a) => a.reason === 'org_policy_v' + s.policy.version));
  const fetchedAt = m.secrets.team.policy.fetched_at;
  s = await m.o.teamSync({ upload: false });
  assert.deepStrictEqual(s.policy, { status: 'current', version: cloud.state.policyVersion });
  assert.ok(m.secrets.team.policy.fetched_at >= fetchedAt);
  // The readable copy was deleted from disk: sync puts it back from the vault.
  fs.rmSync(policy.paths().policyFile);
  await m.o.teamSync({ upload: false });
  assert.strictEqual(policy.readCache().envelope.policy.version, cloud.state.policyVersion);
  // The same version again does not write another audit record.
  const count = m.audit.length;
  await m.o.teamSync({ upload: false });
  assert.strictEqual(m.audit.length, count);
});

test('sync with the server unreachable or failing is offline, not an error, and uploads nothing', async () => {
  const m = await joined();
  m.secrets.team.revoked_at = null;
  net.throwError = true;
  let s = await m.o.teamSync({});
  assert.deepStrictEqual(s.policy, { status: 'offline', error: 'ZN_TEAM_NETWORK' });
  assert.ok(['offline', 'nothing'].includes(s.upload.status), s.upload.status);
  net.throwError = false;
  net.status = 503;
  s = await m.o.teamSync({ upload: false });
  assert.deepStrictEqual(s.policy, { status: 'offline', error: 'ZN_TEAM_HTTP' });
  net.status = 0;
  // An answer that is not a signed policy is also "offline" from the user's point of view.
  const real = global.fetch;
  global.fetch = async () => new Response('{"hello":"world"}', { status: 200, headers: { 'content-type': 'application/json' } });
  cloud.publishPolicy({ rules: [] });
  try { s = await m.o.teamSync({ upload: false }); } finally { global.fetch = real; }
  assert.deepStrictEqual(s.policy, { status: 'offline', error: 'ZN_TEAM_BAD_RESPONSE' });
});

test('the last sync result is kept and shown by teamInfo; a failure leaves one bounded local alert', async () => {
  const m = await joined();
  const alerts = () => m.audit.filter((a) => a.reason === 'team_sync_failed');
  cloud.publishPolicy({ rules: [] });
  assert.strictEqual((await m.o.teamInfo()).last_sync, null, 'nothing synced yet');
  assert.strictEqual((await m.o.teamInfo()).join_pending, true);
  await m.o.teamSync({ upload: false });
  let ls = (await m.o.teamInfo()).last_sync;
  assert.strictEqual(ls.ok, true);
  assert.deepStrictEqual(ls.problems, []);
  assert.strictEqual((await m.o.teamInfo()).join_pending, false);
  assert.strictEqual(alerts().length, 0);
  // Offline: the cause is queryable and one alert is written...
  net.throwError = true;
  await m.o.teamSync({ upload: false });
  ls = (await m.o.teamInfo()).last_sync;
  assert.strictEqual(ls.ok, false);
  assert.match(ls.problems[0], /could not reach the server \(ZN_TEAM_NETWORK\)/);
  assert.ok(ls.last_ok_at, 'the last success is kept');
  assert.deepStrictEqual(alerts(), [{ mode: 'set', decision: 'error', reason: 'team_sync_failed' }]);
  // ...and the job failing again every 15 minutes does not flood the audit log.
  for (let i = 0; i < 5; i++) await m.o.teamSync({ upload: false });
  assert.strictEqual(alerts().length, 1);
  // After 6 hours of failures, one more.
  m.secrets.team.last_sync.alerted_at = new Date(Date.now() - 7 * 3600 * 1000).toISOString();
  await m.o.teamSync({ upload: false });
  assert.strictEqual(alerts().length, 2);
  // Recovery clears the failure; the next failure alerts again.
  net.throwError = false;
  await m.o.teamSync({ upload: false });
  assert.strictEqual((await m.o.teamInfo()).last_sync.ok, true);
  net.throwError = true;
  await m.o.teamSync({ upload: false });
  assert.strictEqual(alerts().length, 3);
  assert.ok(!JSON.stringify(await m.o.teamInfo()).includes('zni_'), 'no token in the status');
});

test('an exception inside a sync is recorded as the last error and still thrown; a failed upload counts as a failed sync', async () => {
  const m = await joined();
  cloud.publishPolicy({ rules: [] });
  // The readable copy cannot be written (a directory is in its place): the sync throws.
  fs.mkdirSync(path.join(policy.paths().policyFile, 'keep'), { recursive: true });
  await assert.rejects(m.o.teamSync({ upload: false }));
  const ls = (await m.o.teamInfo()).last_sync;
  assert.strictEqual(ls.ok, false);
  assert.match(ls.problems[0], /^sync failed: /);
  assert.ok(m.audit.some((a) => a.reason === 'team_sync_failed'));
  fs.rmSync(policy.paths().policyFile, { recursive: true, force: true });
  // A good policy but an upload that fails.
  fs.writeFileSync(m.auditFile, makeAuditChain({ key: AUDIT_KEY, count: 2 }).map((r) => JSON.stringify(r)).join('\n') + '\n');
  const real = global.fetch;
  global.fetch = async (url, init) => (String(url).endsWith('/v1/audit/ingest') ? new Response('{"error":"busy"}', { status: 503, headers: { 'content-type': 'application/json' } }) : real(url, init));
  try { await m.o.teamSync({}); } finally { global.fetch = real; }
  const after = (await m.o.teamInfo()).last_sync;
  assert.strictEqual(after.ok, false);
  assert.match(after.problems[0], /audit upload failed \(offline, 2 records pending\)/);
});

test('a revoked installation is marked, stops uploading, and recovers when the server accepts it again', async () => {
  const m = await joined();
  cloud.publishPolicy({ rules: [] });
  cloud.revokeInstall(m.r.install_id);
  const s = await m.o.teamSync({});
  assert.deepStrictEqual(s.policy, { status: 'revoked' });
  assert.strictEqual(s.upload, null);
  assert.ok(m.secrets.team.revoked_at);
  const info = await m.o.teamInfo();
  assert.ok(info.revoked_at);
  // Revoked twice: the first date stays.
  const first = m.secrets.team.revoked_at;
  await m.o.teamSync({});
  assert.strictEqual(m.secrets.team.revoked_at, first);
  // Joined again (same installation): the server accepts it and the mark is cleared by the next sync.
  const j2 = await m.o.teamJoin({ join_token: cloud.createJoinToken(), api_base: cloud.base });
  assert.strictEqual(j2.install_id, m.r.install_id);
  m.secrets.team.revoked_at = '2026-10-01T00:00:00.000Z';
  const ok = await m.o.teamSync({ upload: false });
  assert.ok(['updated', 'current'].includes(ok.policy.status), ok.policy.status);
  assert.strictEqual(m.secrets.team.revoked_at, null);
});

test('a policy signed by another key, or one that rolls back, is rejected and the held one stays', async () => {
  const m = await joined();
  cloud.publishPolicy({ rules: [{ secret: 'A_B', agents: ['*'], deny: true }] });
  const first = await m.o.teamSync({ upload: false });
  assert.strictEqual(first.policy.status, 'updated');
  // Rollback: the server goes back to an older version (needs a held version above 1).
  cloud.publishPolicy({ rules: [] });
  assert.strictEqual((await m.o.teamSync({ upload: false })).policy.status, 'updated');
  cloud.state.policyVersion -= 1;
  const rolled = await m.o.teamSync({ upload: false });
  assert.strictEqual(rolled.policy.status, 'rejected');
  assert.match(rolled.policy.error, /rollback/);
  const held = m.secrets.team.policy.version;
  // Another signing key: unknown key id.
  cloud.state.policyVersion = held + 1;
  cloud.rotateSigningKey();
  const s2 = await m.o.teamSync({ upload: false });
  assert.deepStrictEqual(s2.policy, { status: 'rejected', error: 'unknown key id' });
  assert.deepStrictEqual(m.audit.at(-1), { mode: 'set', decision: 'deny', reason: 'policy:rejected' });
  assert.strictEqual(m.secrets.team.policy.version, held);
});

test('another signed policy with the version already held but other content is rejected; the same content is not', async () => {
  const m = await joined();
  cloud.publishPolicy({ rules: [{ secret: 'A_B', agents: ['*'], deny: true }] });
  const first = await m.o.teamSync({ upload: false });
  assert.strictEqual(first.policy.status, 'updated');
  const version = m.secrets.team.policy.version;
  assert.match(m.secrets.team.policy.digest, /^[0-9a-f]{64}$/);
  const held = JSON.stringify(m.secrets.team.policy.envelope);
  // The server (or whoever holds the signing key) signs a different policy under the same version.
  cloud.state.policyContent = { rules: [] };
  m.secrets.team.policy.etag = null; // force a full download instead of a 304
  const s = await m.o.teamSync({ upload: false });
  assert.strictEqual(s.policy.status, 'rejected');
  assert.match(s.policy.error, /same version|already used with different content/);
  assert.strictEqual(m.secrets.team.policy.version, version);
  assert.strictEqual(JSON.stringify(m.secrets.team.policy.envelope), held, 'the policy held did not change');
  assert.ok(m.audit.some((a) => a.reason === 'policy:rejected' && a.decision === 'deny'));
  assert.strictEqual(policy.readCache().envelope.policy.rules.length, 1, 'the readable copy did not change either');
  // The same content again (only a new ETag) is a normal update.
  cloud.state.policyContent = { rules: [{ secret: 'A_B', agents: ['*'], deny: true }] };
  m.secrets.team.policy.etag = null;
  assert.strictEqual((await m.o.teamSync({ upload: false })).policy.status, 'updated');
  // A real new version may change the content.
  cloud.state.policyContent = { rules: [] };
  cloud.state.policyVersion += 1;
  m.secrets.team.policy.etag = null;
  assert.strictEqual((await m.o.teamSync({ upload: false })).policy.status, 'updated');
});

test('the version and digest are checked again inside the serialized write', async () => {
  const m = await joined();
  cloud.publishPolicy({ rules: [{ secret: 'A_B', agents: ['*'], deny: true }] });
  // While the download is in flight, another sync stored a newer policy.
  // (The vault object is replaced, as a leave and join would, so the sync still holds the old one.)
  net.afterPolicy = () => { m.secrets.team = { ...m.secrets.team, policy: { envelope: null, version: 99, digest: 'f'.repeat(64), etag: null, fetched_at: new Date().toISOString() } }; };
  const s = await m.o.teamSync({ upload: false });
  assert.strictEqual(s.policy.status, 'rejected');
  assert.match(s.policy.error, /rollback/);
  assert.strictEqual(m.secrets.team.policy.version, 99, 'the newer policy was not overwritten');
  // Leaving and joining another organization during the download: nothing is written for the old one.
  net.afterPolicy = () => { m.secrets.team = { ...m.secrets.team, install_id: '00000000-0000-4000-8000-000000000000' }; };
  m.secrets.team.policy = null;
  const s2 = await m.o.teamSync({ upload: false });
  assert.strictEqual(s2.policy.status, 'rejected');
  assert.match(s2.policy.error, /left the organization/);
  assert.strictEqual(m.secrets.team.policy, null);
});

test('a policy for another organization is rejected', async () => {
  const m = await joined();
  const other = cloud.signRaw({
    org: 'org_AnotherOrg123456', version: 9, rules: [],
    issued_at: new Date(Date.now() - 1000).toISOString(), expires_at: new Date(Date.now() + DAY).toISOString(),
  });
  const real = global.fetch;
  global.fetch = async () => new Response(JSON.stringify(other), { status: 200, headers: { 'content-type': 'application/json', etag: 'W/"x"' } });
  try {
    const s = await m.o.teamSync({ upload: false });
    assert.deepStrictEqual(s.policy, { status: 'rejected', error: 'policy is for another organization' });
  } finally { global.fetch = real; }
});

test('closing the vault during a download stops the sync before it saves anything', async () => {
  const m = await joined();
  cloud.publishPolicy({ rules: [] });
  m.flags.closed = true;
  const s = await m.o.teamSync({});
  assert.deepStrictEqual(s, { policy: { status: 'stopped' }, upload: null });
  assert.strictEqual(m.secrets.team.policy, null);
});

test('sync uploads the audit log; a closed vault in between skips the upload', async () => {
  const m = await joined();
  cloud.publishPolicy({ rules: [] });
  fs.writeFileSync(m.auditFile, makeAuditChain({ key: AUDIT_KEY, count: 3 }).map((r) => JSON.stringify(r)).join('\n') + '\n');
  const s = await m.o.teamSync({});
  assert.strictEqual(s.policy.status, 'updated');
  assert.strictEqual(s.upload.status, 'ok');
  assert.strictEqual(s.upload.uploaded, 3);
  const inst = cloud.state.installs.get(m.r.install_id);
  assert.strictEqual(inst.events.length, 3);
  assert.strictEqual((await m.o.teamSync({})).upload.status, 'nothing');
});

test('an expired policy held in the vault is shown as expired, restricts, and is replaced by a fresh download', async () => {
  const m = await joined();
  const t = m.secrets.team;
  const issued = Date.now() - 30 * DAY;
  const old = cloud.signRaw({
    org: t.org, version: 1, issued_at: new Date(issued).toISOString(), expires_at: new Date(issued + 7 * DAY).toISOString(),
    rules: [{ secret: 'PROD_*', agents: ['*'], deny: true }],
  });
  t.policy = { envelope: old, etag: 'W/"stale"', version: 1, fetched_at: new Date(issued).toISOString() };
  const info = await m.o.teamInfo();
  assert.strictEqual(info.policy.state, 'expired');
  assert.strictEqual(info.policy.version, 1);

  // Strict mode: the deny still applies; a host the policy would open is not offered.
  const list = await m.o.effectiveList([{ name: 'PROD_DB', allowHosts: ['db.example.com'] }, { name: 'DEV_DB', allowHosts: [] }], 'codex', true);
  assert.strictEqual(list[0].deny, true);
  assert.strictEqual(list[0].denyReason, 'policy:org_deny');
  assert.deepStrictEqual(list[0].orgPolicy, { version: 1, state: 'expired' });
  assert.strictEqual(list[1].deny, false);

  // The stale etag is not sent for an expired policy: the server sends the whole new one.
  cloud.publishPolicy({ rules: [] });
  const s = await m.o.teamSync({ upload: false });
  assert.strictEqual(s.policy.status, 'updated');
  const sent = cloud.requests.filter((r) => r.path === '/v1/org/policy').at(-1);
  assert.strictEqual(sent.headers['if-none-match'], undefined);
  assert.strictEqual((await m.o.teamInfo()).policy.state, 'active');
});

test('a held policy that does not verify is reported as invalid and leaves local settings alone', async () => {
  const m = await joined();
  const t = m.secrets.team;
  cloud.publishPolicy({ rules: [{ secret: 'PROD_*', agents: ['*'], deny: true }] });
  await m.o.teamSync({ upload: false });
  t.policy.envelope.policy.rules[0].deny = false; // edited after it was signed
  const info = await m.o.teamInfo();
  assert.strictEqual(info.policy.state, 'invalid');
  assert.strictEqual(info.policy.error, 'bad signature');
  const input = [{ name: 'PROD_DB', allowHosts: ['db.example.com'] }];
  assert.strictEqual(await m.o.effectiveList(input, 'codex', true), input, 'the list is returned as it came');
});

test('effectiveList returns the list untouched when there is no organization or no policy yet', async () => {
  const solo = machine();
  const input = [{ name: 'EXAMPLE_KEY', allowHosts: ['api.example.com'] }];
  assert.strictEqual(await solo.o.effectiveList(input), input);
  const m = await joined();
  assert.strictEqual(await m.o.effectiveList(input), input);
});

test('effectiveList applies deny, warn and narrowing, and marks hosts that wait for an approval', async () => {
  const m = await joined();
  cloud.publishPolicy({ rules: [
    { secret: 'PROD_*', agents: ['*'], deny: true, reason: 'No production secrets' },
    { secret: 'STAGING_KEY', agents: ['*'], warn: true, reason: 'Staging\u200b is monitored' },
    { secret: 'API_KEY', agents: ['claude-code'], allowHosts: ['api.example.com', 'new.example.com'], mode: 'proxy' },
  ] });
  await m.o.teamSync({ upload: false });
  const list = await m.o.effectiveList([
    { name: 'PROD_DB', mode: 'env' },
    { name: 'STAGING_KEY', mode: 'env', allowHosts: ['stg.example.com'] },
    { name: 'API_KEY', mode: 'env', allowHosts: ['api.example.com', 'other.example.com'] },
    { name: 'UNRELATED', mode: 'env' },
  ], 'claude-code', true);
  assert.strictEqual(list[0].deny, true);
  assert.strictEqual(list[1].warn, true);
  assert.ok(list[1].warnReason && !list[1].warnReason.includes('\u200b'));
  assert.deepStrictEqual(list[2].allowHosts, ['api.example.com']);
  assert.strictEqual(list[2].mode, 'proxy');
  assert.deepStrictEqual(list[2].orgPending, [{ kind: 'host', value: 'new.example.com' }]);
  assert.strictEqual(list[3].deny, false);
  assert.strictEqual(list[3].orgPending, undefined);
  assert.strictEqual(list[3].warnReason, undefined);
  assert.strictEqual(list[3].orgPolicy.state, 'active');
  // An agent that is not trusted is never offered an opening.
  const untrusted = await m.o.effectiveList([{ name: 'API_KEY', mode: 'env', allowHosts: ['api.example.com'] }], 'claude-code', false);
  assert.strictEqual(untrusted[0].orgPending, undefined);
});

test('approving a host: bad requests, requests the policy does not make, and the wildcard warning', async () => {
  const m = await joined();
  cloud.publishPolicy({ rules: [{ secret: 'API_KEY', agents: ['claude-code'], allowHosts: ['api.example.com', '*.cdn.example.com'] }] });
  await m.o.teamSync({ upload: false });
  m.secrets.secrets.API_KEY = { value: 'k_' + 'x'.repeat(24), allowHosts: ['api.example.com'] };
  const denied = (args, re) => assert.rejects(m.o.confirmOrgOpening(...args), (e) => e.code === CODES.POLICY_DENIED && re.test(e.message));
  await denied(['lowercase', 'host', 'x.example.com', 'claude-code', true], /invalid request/);
  await denied(['API_KEY', 'command', 'git', 'claude-code', true], /invalid request/);
  await denied(['API_KEY', 'host', 42, 'claude-code', true], /invalid request/);
  await denied(['API_KEY', 'host', 'a'.repeat(254), 'claude-code', true], /invalid request/);
  await assert.rejects(m.o.confirmOrgOpening('NO_SUCH', 'host', 'x.example.com', 'claude-code', true), (e) => e.code === CODES.NOT_FOUND);
  await denied(['API_KEY', 'host', 'unrelated.example.com', 'claude-code', true], /does not ask for this/);
  await denied(['API_KEY', 'host', '*.cdn.example.com', 'claude-code', false], /does not ask for this/);
  await denied(['API_KEY', 'host', '*.cdn.example.com', 'codex', true], /does not ask for this/);
  assert.strictEqual(m.secrets.orgApprovals, undefined);

  assert.strictEqual(await m.o.confirmOrgOpening('API_KEY', 'host', '*.cdn.example.com', 'claude-code', true), true);
  const dialog = m.dialogs.at(-1);
  assert.strictEqual(dialog.kind, 'policy');
  assert.ok(dialog.warnings.some((w) => /wildcard: it allows every host that ends in \.cdn\.example\.com/.test(w)));
  assert.deepStrictEqual(dialog.fields.find(([k]) => k === 'Agent'), ['Agent', 'claude-code']);
  const org = m.secrets.team.org;
  assert.ok(m.secrets.orgApprovals[approvalKey(org, 'API_KEY', 'host', '*.cdn.example.com')]);
  assert.deepStrictEqual(m.audit.at(-1), { secret: 'API_KEY', mode: 'set', decision: 'ask:yes', reason: 'org_open_host' });
  // Approved: nothing is pending any more for that host.
  const list = await m.o.effectiveList([{ name: 'API_KEY', allowHosts: ['api.example.com'] }], 'claude-code', true);
  assert.deepStrictEqual(list[0].allowHosts.sort(), ['*.cdn.example.com', 'api.example.com']);
  assert.strictEqual(list[0].orgPending, undefined);
});

test('approving an exact host shows no wildcard warning, names an unknown agent, and a declined dialog saves nothing', async () => {
  const m = await joined();
  cloud.publishPolicy({ rules: [{ secret: 'API_KEY', agents: ['*'], allowHosts: ['new.example.com'] }] });
  await m.o.teamSync({ upload: false });
  m.secrets.secrets.API_KEY = { value: 'k_' + 'x'.repeat(24), allowHosts: ['api.example.com'] };
  assert.strictEqual(await m.o.confirmOrgOpening('API_KEY', 'host', 'new.example.com', null, false), true);
  const dialog = m.dialogs.at(-1);
  assert.strictEqual(dialog.warnings.length, 1);
  assert.deepStrictEqual(dialog.fields.find(([k]) => k === 'Agent'), ['Agent', 'unknown']);

  const m2 = await joined({ answer: false });
  cloud.publishPolicy({ rules: [{ secret: 'API_KEY', agents: ['*'], allowHosts: ['new.example.com'] }] });
  await m2.o.teamSync({ upload: false });
  m2.secrets.secrets.API_KEY = { value: 'k_' + 'x'.repeat(24), allowHosts: ['api.example.com'] };
  await assert.rejects(m2.o.confirmOrgOpening('API_KEY', 'host', 'new.example.com', 'codex', true), /declined/);
  assert.strictEqual(m2.secrets.orgApprovals, undefined);
});

test('approving without an organization is "nothing to approve"', async () => {
  const m = machine();
  await assert.rejects(m.o.confirmOrgOpening('API_KEY', 'host', 'x.example.com', 'codex', true), (e) => e.code === CODES.NOT_FOUND && /nothing to approve/.test(e.message));
});
