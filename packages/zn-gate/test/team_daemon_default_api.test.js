'use strict';
// zn team join: which server a join talks to (lib/team/daemon-ops.js DEFAULT_API). Without api_base the
// zn service is used and the dialog carries no "not the zn service" warning; another base is flagged.
// Uses the fake team server behind an injected fetch; no real network.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-default-api-'));
process.env.ZN_HOME = path.join(HOME, '.zn');

const crypto = require('crypto');
const { makeTeamOps, DEFAULT_API } = require('../lib/team/daemon-ops');
const { kidOf } = require('../lib/team/policy');

const OTHER_BASE = 'https://zn.example.test';

test.after(() => { fs.rmSync(HOME, { recursive: true, force: true }); });

const TOKEN = 'znj_' + 'A'.repeat(40);
const RAW_KEY = crypto.randomBytes(32).toString('base64url');
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function machine() {
  const secrets = { auditKey: 'ab'.repeat(32) };
  const dialogs = []; const hosts = [];
  // A fake client: answers the preview and the join itself and records the origin of every request.
  const fetchImpl = async (url) => {
    const u = new URL(String(url));
    hosts.push(u.origin);
    if (u.pathname === '/v1/org/join-preview') return json(200, { org_name: 'Example Org', invited_by: null, expires_at: '2030-01-01T00:00:00Z' });
    if (u.pathname === '/v1/org/join') {
      return json(201, {
        org: 'org_example01', org_name: 'Example Org',
        policy_url: u.origin + '/v1/org/policy', audit_url: u.origin + '/v1/audit/ingest',
        policy_public_key: { alg: 'Ed25519', kid: kidOf(RAW_KEY), key: RAW_KEY },
        install_token: 'zni_00000000-0000-4000-8000-000000000000_' + 'a'.repeat(32),
      });
    }
    return json(404, { error: 'not found' });
  };
  const state = {
    opts: { home: process.env.ZN_HOME },
    paths: { auditFile: path.join(process.env.ZN_HOME, 'audit.jsonl') },
    loadSecrets: async () => secrets, saveSecrets: async () => {}, serial: (fn) => fn(),
  };
  const o = makeTeamOps({
    state, fetchImpl, writeAudit: () => {},
    confirmOutOfBand: async (req) => { if (/^look up the organization/.test(req.title)) return; dialogs.push(req); },
  });
  return { o, dialogs, hosts, secrets };
}

test('the default server is the zn service', () => {
  assert.strictEqual(DEFAULT_API, 'https://api.usezn.com');
});

test('a join without api_base uses the default server and shows no "not the zn service" warning', async () => {
  const m = machine();
  const r = await m.o.teamJoin({ join_token: TOKEN });
  assert.strictEqual(r.api_base, DEFAULT_API);
  assert.ok(m.hosts.length > 0);
  assert.ok(m.hosts.every((h) => h === DEFAULT_API), 'every request went to the default server');
  assert.strictEqual(m.dialogs.length, 1);
  assert.ok(!m.dialogs[0].warnings.some((w) => w.includes('not the zn service')));
});

test('a join with another base on a .test host warns that it is not the zn service', async () => {
  const m = machine();
  const r = await m.o.teamJoin({ join_token: TOKEN, api_base: OTHER_BASE });
  assert.strictEqual(r.api_base, OTHER_BASE);
  assert.ok(m.hosts.every((h) => h === OTHER_BASE), 'no request went to the default server');
  assert.ok(m.dialogs[0].warnings.some((w) => w.includes('not the zn service') && w.includes('zn.example.test')));
});
