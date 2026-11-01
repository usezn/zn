'use strict';
// The vault's keychain.json carries the organization id from join to leave, so the reset, purge and uninstall
// guards still know this is a Team machine when team.json and org-policy.json are deleted (vault locked).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-team-marker-'));
process.env.ZN_HOME = path.join(HOME, '.zn');

const { startFakeTeamServer } = require('./helpers/fake_team_server');
const { makeTeamOps } = require('../lib/team/daemon-ops');
const policy = require('../lib/team/policy');
const store = require('../lib/vault/store');
const keychain = require('../lib/vault/keychain');

let cloud;
test.before(async () => { cloud = await startFakeTeamServer(); });
test.after(async () => { await cloud.close(); fs.rmSync(HOME, { recursive: true, force: true }); });

test('join writes the marker, a deleted pair still counts, leave clears it', async () => {
  fs.mkdirSync(path.dirname(store.paths({}).metaFile), { recursive: true });
  keychain.writeMeta({ v: 1, backend: 'passphrase', recipient: 'age1' + 'q'.repeat(20), created: new Date().toISOString() }, {});
  assert.equal(policy.onTeamMachine({}), false);
  const secrets = { auditKey: 'ab'.repeat(32), secrets: {} };
  const state = { opts: { home: process.env.ZN_HOME }, paths: { auditFile: path.join(process.env.ZN_HOME, 'audit.jsonl') }, loadSecrets: async () => secrets, saveSecrets: async () => {}, serial: (fn) => fn() };
  const o = makeTeamOps({ state, fetchImpl: fetch, writeAudit: () => {}, isClosed: () => false, confirmOutOfBand: async () => {} });
  const r = await o.teamJoin({ join_token: cloud.createJoinToken({ maxUses: 5 }), api_base: cloud.base, agent: 'claude-code' });
  assert.equal(keychain.readMeta({}).team_org, r.org);
  policy.removeFile(policy.paths().teamFile);
  policy.removeFile(policy.paths().policyFile);
  assert.equal(policy.onTeamMachine({}), true, 'files deleted, the marker remains');
  await o.teamLeave();
  assert.equal(keychain.readMeta({}).team_org, undefined);
  assert.equal(policy.onTeamMachine({}), false);
});
