'use strict';
// zn team leave when the saved API address of the organization is unusable: the server cannot be told, the installation stays
// listed as pending, and the leave still answers (no throw, no network call).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'zn-cov56-daemon-leave-'));
process.env.ZN_HOME = path.join(HOME, '.zn');

const { makeTeamOps } = require('../lib/team/daemon-ops');

test.after(() => fs.rmSync(HOME, { recursive: true, force: true }));
test.beforeEach(() => {
  fs.rmSync(process.env.ZN_HOME, { recursive: true, force: true });
  fs.mkdirSync(process.env.ZN_HOME, { recursive: true });
});

async function noNetwork() { throw new TypeError('no network in this test'); }

function machine(team) {
  const secrets = { auditKey: 'ab'.repeat(32), secrets: {}, team };
  const state = {
    opts: { home: process.env.ZN_HOME },
    paths: { auditFile: path.join(process.env.ZN_HOME, 'audit.jsonl') },
    loadSecrets: async () => secrets,
    saveSecrets: async () => {},
    serial: (fn) => fn(),
  };
  return makeTeamOps({
    state,
    fetchImpl: noNetwork,
    writeAudit: () => {},
    isClosed: () => false,
    confirmOutOfBand: async () => {},
  });
}

test('leave with an unusable API address keeps the installation pending instead of throwing', async () => {
  const team = {
    org: 'org_Unusable12345678',
    org_name: 'Example Org',
    api_base: 'not a url',
    install_id: 'inst-unusable',
    install_token: 'znt_' + 'x'.repeat(20),
    policy_public_key: { alg: 'Ed25519', kid: '0'.repeat(16), key: 'A'.repeat(43) },
  };
  const r = await machine(team).teamLeave();
  assert.equal(r.left, 'org_Unusable12345678');
  assert.ok(r.revocation, JSON.stringify(r));
  assert.equal(r.revocation.status, 'pending', JSON.stringify(r.revocation));
  assert.match(String(r.revocation.error || ''), /could not ask the server/);
});
