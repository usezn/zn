'use strict';
/* A signed Team policy with redaction.pii: the hook keeps personal data protected whatever the local settings say. */
process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-team-pii-'));
process.env.ZN_HOME = path.join(HOME, '.zn');
delete process.env.ZN_EGRESS_CHECK;

const adapter = require('../lib/agents/claude-code');
const policy = require('../lib/team/policy');
const { redactionOf } = require('../lib/team/effective');
const { createFakeVault } = require('./helpers/fake_vault');

const ORG = 'org_TestOrg12345678';
const keys = crypto.generateKeyPairSync('ed25519');
const der = keys.publicKey.export({ format: 'der', type: 'spki' });
const KEY = der.subarray(der.length - 32).toString('base64url');
const PIN = { alg: 'Ed25519', kid: policy.kidOf(KEY), key: KEY };
const PROJECT = fs.mkdtempSync(path.join(HOME, 'project-'));
spawnSync('git', ['init', '-q'], { cwd: PROJECT });
const EMAIL = 'jane.doe@example.com';

test.after(() => fs.rmSync(HOME, { recursive: true, force: true }));
test.beforeEach(() => {
  fs.rmSync(process.env.ZN_HOME, { recursive: true, force: true });
  fs.mkdirSync(process.env.ZN_HOME, { recursive: true });
});

function envelope(extra) {
  const now = Date.now();
  const p = Object.assign({ org: ORG, version: 1, issued_at: new Date(now - 1000).toISOString(), expires_at: new Date(now + 86400000).toISOString(), rules: [] }, extra || {});
  const sig = crypto.sign(null, Buffer.from(policy.canonicalJson(p), 'utf8'), keys.privateKey).toString('base64url');
  return { policy: p, signature: { alg: 'Ed25519', kid: PIN.kid, sig } };
}
function join(extra) {
  policy.writeTeam({ org: ORG, api_base: 'https://api.usezn.com', install_id: crypto.randomUUID(), policy_public_key: PIN });
  policy.writeCache(envelope(extra));
}
function freshRunner() {
  delete require.cache[require.resolve('../lib/hooks/runner')];
  return require('../lib/hooks/runner');
}
function pre(url) {
  return { session_id: 's', cwd: PROJECT, permission_mode: 'default', hook_event_name: 'PreToolUse', tool_name: 'WebFetch', tool_input: { url, prompt: 'x' }, tool_use_id: 't1' };
}
function post(text) {
  return {
    session_id: 's', cwd: PROJECT, permission_mode: 'default', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'cat f' },
    tool_response: { stdout: text, stderr: '', interrupted: false, isImage: false }, tool_use_id: 't2',
  };
}
async function postOut(vault) {
  const res = await freshRunner().handle(adapter, post('contact ' + EMAIL + '\n'), { vault, failMode: 'open' });
  const o = res.output && res.output.hookSpecificOutput;
  return o && o.updatedToolOutput ? o.updatedToolOutput.stdout : null;
}
async function egress(vault) {
  const res = await freshRunner().handle(adapter, pre('https://api.example.com/x?mail=' + EMAIL), { vault, failMode: 'open', egressCheck: 'off' });
  return JSON.stringify(res.output || {});
}
const ASKED = /personal data|email/i;

test('redactionOf: only an active or expired policy that says true', () => {
  assert.deepEqual(redactionOf(null), { pii: false, ner: false });
  assert.deepEqual(redactionOf({ state: 'active', policy: {} }), { pii: false, ner: false });
  assert.deepEqual(redactionOf({ state: 'active', policy: { redaction: { pii: true, ner: false } } }), { pii: true, ner: false });
  assert.deepEqual(redactionOf({ state: 'expired', policy: { redaction: { pii: true } } }), { pii: true, ner: false });
  assert.deepEqual(redactionOf({ state: 'invalid', policy: { redaction: { pii: true } } }), { pii: false, ner: false });
});

test('output personal data is scrubbed with the policy on', async () => {
  join({ redaction: { pii: true } });
  assert.ok(!String(await postOut(createFakeVault())).includes(EMAIL));
});

test('policy pii=true: egressCheck "off" from the local settings no longer silences the personal-data question', async () => {
  join({ redaction: { pii: true } });
  assert.match(await egress(createFakeVault()), ASKED);
});

test('policy absent: egressCheck "off" from the local settings still works', async () => {
  assert.doesNotMatch(await egress(createFakeVault()), ASKED);
});

test('policy pii=false: egressCheck "off" from the local settings still works', async () => {
  join({ redaction: { pii: false, ner: true } });
  assert.doesNotMatch(await egress(createFakeVault()), ASKED);
});

test('policy held in the vault (readable copies deleted) applies the same way', async () => {
  const vault = Object.assign(createFakeVault(), {
    teamHookInfo: async () => ({ joined: true, org: ORG, state: 'active', version: 1, detectors: [], redaction: { pii: true, ner: false }, change: null }),
  });
  assert.match(await egress(vault), ASKED);
});
