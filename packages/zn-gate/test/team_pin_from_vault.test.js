'use strict';
/*
 * The hooks take the organization's pinned key from the vault, not from team.json alone: a team.json with an
 * attacker's own key plus a policy signed by that key is a consistent pair of plain files, and must not switch
 * the organization's detectors off. The "policy lifted" line cannot be hidden by editing team-notice.json.
 */
process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-team-pinvault-'));
process.env.ZN_HOME = path.join(HOME, '.zn');

const adapter = require('../lib/agents/claude-code');
const policy = require('../lib/team/policy');
const { startFakeTeamServer } = require('./helpers/fake_team_server');
const { makeTeamOps } = require('../lib/team/daemon-ops');
const { createFakeVault } = require('./helpers/fake_vault');

const AUDIT_KEY = 'ab'.repeat(32);
const ACME = 'ACME-' + 'K7Q2ZP4M9XW3LB8RT5VN6YC1';
const DETECTOR = { id: 'acme', pattern: 'ACME-[A-Z0-9]{24}', type: 'ACME_TOKEN' };
const PROJECT = fs.mkdtempSync(path.join(HOME, 'project-'));
spawnSync('git', ['init', '-q'], { cwd: PROJECT });
let cloud;

test.before(async () => { cloud = await startFakeTeamServer(); });
test.after(async () => { await cloud.close(); fs.rmSync(HOME, { recursive: true, force: true }); });
test.beforeEach(() => {
  cloud.setOrgActive(true);
  fs.rmSync(process.env.ZN_HOME, { recursive: true, force: true });
  fs.mkdirSync(process.env.ZN_HOME, { recursive: true });
});

async function joined() {
  const audit = [];
  const secrets = { auditKey: AUDIT_KEY, secrets: {} };
  const state = {
    opts: { home: process.env.ZN_HOME },
    paths: { auditFile: path.join(process.env.ZN_HOME, 'audit.jsonl') },
    loadSecrets: async () => secrets,
    saveSecrets: async () => {},
    serial: (fn) => fn(),
  };
  const o = makeTeamOps({ state, fetchImpl: fetch, writeAudit: (r) => audit.push(r), isClosed: () => false, confirmOutOfBand: async () => {} });
  const r = await o.teamJoin({ join_token: cloud.createJoinToken({ maxUses: 20 }), api_base: cloud.base, agent: 'claude-code' });
  return { o, audit, secrets, r };
}

/* A vault for the hook that answers like the daemon does. */
const vaultOf = (m) => Object.assign(createFakeVault(), {
  teamHookInfo: (a) => m.o.teamHookInfo(a),
  teamChangeShown: (to) => m.o.teamChangeShown(to),
});

const post = () => ({
  session_id: 's', cwd: PROJECT, permission_mode: 'default', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'env' },
  tool_response: { stdout: 'export INTERNAL=' + ACME + '\n', stderr: '', interrupted: false, isImage: false }, tool_use_id: 'toolu_1',
});

async function run(vault) {
  delete require.cache[require.resolve('../lib/hooks/runner')];
  const runner = require('../lib/hooks/runner');
  const res = await runner.handle(adapter, post(), { vault, failMode: 'open' });
  const out = res.output && res.output.hookSpecificOutput;
  return { redacted: Boolean(out && out.updatedToolOutput && !out.updatedToolOutput.stdout.includes(ACME)), message: (res.output && res.output.systemMessage) || '' };
}

/* The pair a process of the same user can write: its own key in team.json, a v99 policy signed by it, no detectors. */
function forgePair(m) {
  const keys = crypto.generateKeyPairSync('ed25519');
  const der = keys.publicKey.export({ format: 'der', type: 'spki' });
  const key = der.subarray(der.length - 32).toString('base64url');
  const pin = { alg: 'Ed25519', kid: policy.kidOf(key), key };
  policy.writeTeam({ org: m.r.org, api_base: cloud.base, install_id: crypto.randomUUID(), policy_public_key: pin });
  const now = Date.now();
  const p = { org: m.r.org, version: 99, issued_at: new Date(now - 1000).toISOString(), expires_at: new Date(now + 86400000).toISOString(), rules: [] };
  const sig = crypto.sign(null, Buffer.from(policy.canonicalJson(p), 'utf8'), keys.privateKey).toString('base64url');
  policy.writeCache({ policy: p, signature: { alg: 'Ed25519', kid: pin.kid, sig } });
  return pin;
}

test('normal flow: the readable copies match the vault, detectors apply, no line, no audit record', async () => {
  const m = await joined();
  cloud.publishPolicy({ rules: [], detectors: [DETECTOR] });
  await m.o.teamSync({ upload: false });
  const r = await run(vaultOf(m));
  assert.ok(r.redacted);
  assert.equal(r.message, '');
  assert.ok(!m.audit.some((a) => a.reason === 'team_pin_mismatch'));
});

test('a forged but self-consistent team.json + org-policy.json pair is not accepted: the vault policy applies', async () => {
  const m = await joined();
  cloud.publishPolicy({ rules: [], detectors: [DETECTOR] });
  await m.o.teamSync({ upload: false });
  const realKid = m.secrets.team.pin.kid;
  const fakePin = forgePair(m);
  // Without the vault check the hook would see an active v99 policy with no detectors.
  assert.equal(policy.state({}).state, 'active');
  assert.equal(policy.state({}).version, 99);
  assert.notEqual(fakePin.kid, realKid);
  const r = await run(vaultOf(m));
  assert.ok(r.redacted, 'the organization detector still applies');
  assert.match(r.message, /did not match the one in your vault/);
  assert.ok(m.audit.some((a) => a.reason === 'team_pin_mismatch' && a.decision === 'error'), 'logged by the vault');
  // The vault put the real copies back.
  assert.equal(policy.readTeam().policy_public_key.kid, realKid);
  assert.equal(policy.state({}).version, m.secrets.team.policy.envelope.policy.version);
});

test('a pin that differs with a vault policy that does not verify fails closed with the notice, never the forged policy', async () => {
  const m = await joined();
  cloud.publishPolicy({ rules: [], detectors: [DETECTOR] });
  await m.o.teamSync({ upload: false });
  forgePair(m);
  const vault = Object.assign(createFakeVault(), {
    teamHookInfo: async (a) => Object.assign(await m.o.teamHookInfo(a), { state: 'invalid', detectors: [] }),
  });
  const r = await run(vault);
  assert.ok(!r.redacted);
  assert.match(r.message, /did not match the one in your vault/);
  assert.match(r.message, /Team detectors not applied/);
});

test('a policy newer in the vault than the readable copy is used (an older signed copy put back by hand)', async () => {
  const m = await joined();
  cloud.publishPolicy({ rules: [], detectors: [] });
  await m.o.teamSync({ upload: false });
  const oldCopy = fs.readFileSync(policy.paths().policyFile, 'utf8');
  cloud.publishPolicy({ rules: [], detectors: [DETECTOR] });
  await m.o.teamSync({ upload: false });
  fs.writeFileSync(policy.paths().policyFile, oldCopy);
  assert.ok((await run(vaultOf(m))).redacted);
});

test('team-notice.json cannot hide the policy-lifted line: what was shown is kept in the vault', async () => {
  const m = await joined();
  cloud.publishPolicy({ rules: [{ secret: 'PROD_*', agents: ['*'], deny: true }], detectors: [DETECTOR] });
  await m.o.teamSync({ upload: false });
  cloud.publishPolicy({ rules: [], detectors: [DETECTOR] });
  const second = await m.o.teamSync({ upload: false });
  const to = second.policy.version;
  // Pre-written "already shown" marker, and the change removed from the readable copy.
  fs.writeFileSync(path.join(process.env.ZN_HOME, 'team-notice.json'), JSON.stringify({ change_to: to, change_org: m.r.org }));
  const c = JSON.parse(fs.readFileSync(policy.paths().policyFile, 'utf8'));
  delete c.change;
  fs.writeFileSync(policy.paths().policyFile, JSON.stringify(c));
  const vault = vaultOf(m);
  const first = await run(vault);
  assert.match(first.message, /your organization changed its policy \(version \d+\) and removed or loosened 1 restriction/);
  assert.equal(m.secrets.team.policy.change_shown, to);
  // Once per change, and a forged "not shown" marker file does not bring it back either.
  assert.equal((await run(vault)).message, '');
  fs.writeFileSync(path.join(process.env.ZN_HOME, 'team-notice.json'), '{}');
  assert.equal((await run(vault)).message, '');
});

test('a locked vault cannot confirm the pin: the readable copies apply as before (known limit)', async () => {
  const m = await joined();
  cloud.publishPolicy({ rules: [], detectors: [DETECTOR] });
  await m.o.teamSync({ upload: false });
  const locked = Object.assign(createFakeVault(), { teamHookInfo: async () => { throw new Error('vault is locked'); } });
  const r = await run(locked);
  assert.ok(r.redacted);
  assert.equal(r.message, '');
});

test('teamChangeShown records only the current change', async () => {
  const m = await joined();
  cloud.publishPolicy({ rules: [{ secret: 'PROD_*', agents: ['*'], deny: true }], detectors: [] });
  await m.o.teamSync({ upload: false });
  cloud.publishPolicy({ rules: [], detectors: [] });
  const second = await m.o.teamSync({ upload: false });
  assert.equal(await m.o.teamChangeShown(second.policy.version), true);
  assert.equal(await m.o.teamChangeShown(second.policy.version + 5), false);
  assert.equal(await m.o.teamChangeShown('x'), false);
  assert.equal(m.secrets.team.policy.change_shown, second.policy.version);
});
