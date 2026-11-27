'use strict';
/*
 * The organization has no active Team subscription (the policy download answers 402).
 * Against docs/team.md "Offline, expiry and removal":
 *   - the policy held keeps applying until it expires, then strict mode (402 never lifts a restriction);
 *   - a flag with the time seen is kept, and cleared by the next successful download;
 *   - `zn team status` says it plainly and who to ask; a block in strict mode names the cause.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-team-nosub-'));
process.env.ZN_HOME = path.join(HOME, '.zn');
process.env.ZN_STATS = 'off';

const { startFakeTeamServer } = require('./helpers/fake_team_server');
const { makeTeamOps } = require('../lib/team/daemon-ops');
const { describePolicy } = require('../lib/team/cli');
const { syncOutcome } = require('../lib/team/sync-outcome');
const messages = require('../lib/messages');

const DAY = 86400000;
let cloud;
test.before(async () => { cloud = await startFakeTeamServer(); });
test.after(async () => { await cloud.close(); fs.rmSync(HOME, { recursive: true, force: true }); });
test.beforeEach(() => {
  cloud.setOrgActive(true);
  fs.rmSync(process.env.ZN_HOME, { recursive: true, force: true });
  fs.mkdirSync(process.env.ZN_HOME, { recursive: true });
});

async function joined() {
  const secrets = { auditKey: 'ab'.repeat(32), secrets: {} };
  const state = {
    opts: { home: process.env.ZN_HOME }, paths: { auditFile: path.join(process.env.ZN_HOME, 'audit.jsonl') },
    loadSecrets: async () => secrets, saveSecrets: async () => {}, serial: (fn) => fn(),
  };
  const o = makeTeamOps({ state, writeAudit: () => {}, isClosed: () => false, confirmOutOfBand: async () => {} });
  cloud.publishPolicy({ rules: [{ secret: 'PROD_*', agents: ['*'], deny: true }] });
  await o.teamJoin({ join_token: cloud.createJoinToken({ maxUses: 20 }), api_base: cloud.base, agent: 'claude-code' });
  await o.teamSync({ upload: false });
  assert.strictEqual((await o.teamInfo()).policy.state, 'active');
  return { o, secrets };
}

test('402 sets the flag, keeps the last policy until it expires, and never lifts a restriction', async () => {
  const { o, secrets } = await joined();
  assert.strictEqual((await o.teamInfo()).policy.subscription_inactive_at, null);
  cloud.setOrgActive(false);
  const r = await o.teamSync({ upload: false });
  assert.strictEqual(r.policy.status, 'no_subscription');
  assert.match(syncOutcome(r).problems[0], /Team subscription is not active.*strict mode.*Ask your organization owner or admin/);
  assert.strictEqual(syncOutcome(r).ok, false);
  const info = await o.teamInfo();
  assert.strictEqual(info.policy.state, 'active', 'the last policy still applies');
  assert.ok(Number.isFinite(Date.parse(info.policy.subscription_inactive_at)));
  const list = await o.effectiveList([{ name: 'PROD_DB', allowHosts: [] }], 'codex', true);
  assert.strictEqual(list[0].deny, true, 'the deny still applies');
  assert.strictEqual(list[0].orgPolicy.subscription_inactive, true);

  // The policy expires while the subscription is still inactive: strict mode, never "no restrictions".
  const t = secrets.team;
  const issued = Date.now() - 30 * DAY;
  t.policy.envelope = cloud.signRaw({
    org: t.org, version: t.policy.version, issued_at: new Date(issued).toISOString(), expires_at: new Date(issued + 7 * DAY).toISOString(),
    rules: [{ secret: 'PROD_*', agents: ['*'], deny: true }],
  });
  await o.teamSync({ upload: false });
  const info2 = await o.teamInfo();
  assert.strictEqual(info2.policy.state, 'expired');
  assert.ok(info2.policy.subscription_inactive_at);
  const list2 = await o.effectiveList([{ name: 'PROD_DB', allowHosts: [] }, { name: 'DEV_DB', allowHosts: [] }], 'codex', true);
  assert.strictEqual(list2[0].deny, true, 'still denied in strict mode');
  assert.deepStrictEqual(list2[0].orgPolicy, { version: t.policy.version, state: 'expired', subscription_inactive: true });
  assert.strictEqual(list2[1].deny, false);
});

test('the next successful download clears the flag', async () => {
  const { o, secrets } = await joined();
  cloud.setOrgActive(false);
  await o.teamSync({ upload: false });
  assert.ok(secrets.team.subscription_inactive);
  cloud.setOrgActive(true);
  const r = await o.teamSync({ upload: false });
  assert.ok(['current', 'updated'].includes(r.policy.status));
  assert.strictEqual(secrets.team.subscription_inactive, undefined);
  assert.strictEqual((await o.teamInfo()).policy.subscription_inactive_at, null);
});

test('a network failure does not set the flag', async () => {
  const { o, secrets } = await joined();
  await cloud.close();
  const r = await o.teamSync({ upload: false });
  assert.strictEqual(r.policy.status, 'offline');
  assert.strictEqual(secrets.team.subscription_inactive, undefined);
  cloud = await startFakeTeamServer();
});

test('status text: active policy, expired policy, and without the flag', () => {
  const at = '2026-11-27T10:00:00.000Z';
  const exp = describePolicy({ state: 'expired', version: 3, expires_at: '2026-11-20T00:00:00.000Z', subscription_inactive_at: at });
  assert.match(exp, /EXPIRED: strict mode \(only restrictions apply; nothing the organization opened stays open\) because your organization's Team subscription is not active\. Ask your organization owner or admin\.$/);
  assert.doesNotMatch(exp, /check its date and time/);
  assert.match(describePolicy({ state: 'expired', version: 3, expires_at: '2026-11-20T00:00:00.000Z' }), /until zn can reach the server/);
  assert.match(messages.TEAM_STRICT_NO_SUBSCRIPTION, /strict mode because your organization's Team subscription is not active.*Ask your organization owner or admin\.$/);
});
