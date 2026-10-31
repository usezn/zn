'use strict';
/*
 * An install token that the server says has expired (HTTP 401 with code install_token_expired) is not a removal:
 * the last policy keeps applying (enforcement never relaxes), nothing is marked revoked, the upload is not tried,
 * and the user is told in plain words how to join again. A plain 401 is still "removed from the organization".
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-team-expired-'));
process.env.ZN_HOME = path.join(HOME, '.zn');

const { startFakeTeamServer } = require('./helpers/fake_team_server');
const { makeTeamOps } = require('../lib/team/daemon-ops');
const { createApi } = require('../lib/team/api');
const { syncOutcome } = require('../lib/team/sync-outcome');
const { uploadPending } = require('../lib/team/upload');
const policy = require('../lib/team/policy');
const audit = require('../lib/vault/audit');
const messages = require('../lib/messages');

const AUDIT_KEY = 'ab'.repeat(32);
let cloud;
test.before(async () => { cloud = await startFakeTeamServer(); });
test.after(async () => { await cloud.close(); fs.rmSync(HOME, { recursive: true, force: true }); });
test.beforeEach(() => {
  cloud.setOrgActive(true);
  fs.rmSync(process.env.ZN_HOME, { recursive: true, force: true });
  fs.mkdirSync(process.env.ZN_HOME, { recursive: true });
});

async function joined() {
  const secrets = { auditKey: AUDIT_KEY, secrets: {} };
  const state = {
    opts: { home: process.env.ZN_HOME },
    paths: { auditFile: path.join(process.env.ZN_HOME, 'audit.jsonl') },
    loadSecrets: async () => secrets, saveSecrets: async () => {}, serial: async (fn) => fn(),
  };
  const o = makeTeamOps({ state, fetchImpl: fetch, writeAudit: () => {}, confirmOutOfBand: async () => {} });
  await o.teamJoin({ join_token: cloud.createJoinToken({ maxUses: 5 }), api_base: cloud.base });
  return { o, secrets };
}

test('an expired token: the cached policy stays, nothing is marked revoked, the upload is not tried', async () => {
  const { o, secrets } = await joined();
  cloud.publishPolicy({ rules: [{ secret: 'A_B', agents: ['*'], deny: true }] });
  const first = await o.teamSync({ upload: false });
  assert.strictEqual(first.policy.status, 'updated');
  const kept = secrets.team.policy;
  assert.ok(kept && kept.envelope);

  cloud.expireInstall(secrets.team.install_id);
  const s = await o.teamSync({});
  assert.strictEqual(s.policy.status, 'expired');
  assert.ok(!s.upload, "no upload with an expired token");
  assert.ok(!secrets.team.revoked_at, 'not a removal');
  assert.strictEqual(secrets.team.policy, kept, 'the last policy still applies');
  assert.ok(policy.readCache(), 'and so does the readable copy');
  const out = syncOutcome(s);
  assert.strictEqual(out.ok, false);
  assert.match(out.problems[0], /install token expired after 90 days.*last policy still applies.*zn team leave/);
});

test('a plain 401 is still a removal', async () => {
  const { o, secrets } = await joined();
  cloud.revokeInstall(secrets.team.install_id);
  const s = await o.teamSync({});
  assert.strictEqual(s.policy.status, 'revoked');
  assert.ok(secrets.team.revoked_at);
});

test('the api client keeps the code of the 401 body', async () => {
  const { secrets } = await joined();
  cloud.expireInstall(secrets.team.install_id);
  const api = createApi({ base: cloud.base, token: secrets.team.install_token });
  await assert.rejects(api.getPolicy(), (e) => e.status === 401 && e.body && e.body.code === 'install_token_expired' && !e.message.includes(secrets.team.install_token));
});

test('an upload refused with install_token_expired stops as expired, a plain 401 as revoked', async () => {
  const dir = fs.mkdtempSync(path.join(HOME, 'up-'));
  const f = { auditFile: path.join(dir, 'audit.jsonl'), stateFile: path.join(dir, 'up.json'), lockFile: path.join(dir, 'up.lock') };
  const key = crypto.randomBytes(32);
  for (let i = 0; i < 3; i++) audit.append({ decision: 'allow', secret: 'K_' + i, mode: 'env', agent: 'claude-code', tool: 'Bash', host: 'api.example.com', reason: 'policy' }, { file: f.auditFile, key });
  for (const [body, want] of [[{ error: 'x', code: 'install_token_expired' }, 'expired'], [{ error: 'x' }, 'revoked']]) {
    fs.rmSync(f.stateFile, { force: true });
    const api = { ingest: async () => { const e = new Error('HTTP 401'); e.status = 401; e.body = body; throw e; } };
    const r = await uploadPending({ auditFile: f.auditFile, stateFile: f.stateFile, lockFile: f.lockFile, api, installId: '6f1c2b1e-0000-4000-8000-000000000001', version: '1.14.0', startAfterSeq: 0 });
    assert.strictEqual(r.status, want);
    assert.strictEqual(r.pending, 3, 'nothing is lost');
  }
});

test('the message says what happened, that nothing is lost and what to run', () => {
  assert.match(messages.TEAM_TOKEN_EXPIRED, /90 days/);
  assert.match(messages.TEAM_TOKEN_EXPIRED, /last policy you received still applies/);
  assert.match(messages.TEAM_TOKEN_EXPIRED, /zn team leave.*zn team join <token>/);
  assert.ok(!/ZN_|install_token_expired/.test(messages.TEAM_TOKEN_EXPIRED));
});
