'use strict';
/*
 * zn Team end to end on one machine: a real vault daemon, the "secrets" MCP
 * server as Claude Code and Codex start it, and a local server that speaks
 * the zn cloud contract. Join (confirmed outside the agent), signed policy,
 * per-agent deny, an opening that needs a local approval, audit upload,
 * offline, revocation and leave.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

/* Async: the vault daemon runs in this process and must keep answering. */
function zn(args) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [CLI, ...args], { env: process.env });
    let stdout = '';
    let stderr = '';
    c.stdout.on('data', (d) => { stdout += d; });
    c.stderr.on('data', (d) => { stderr += d; });
    c.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-team-e2e-'));
process.env.ZN_HOME = path.join(HOME, '.zn');
process.env.ZN_KEYCHAIN_BACKEND = 'passphrase';

const keychain = require('../lib/vault/keychain');
const daemon = require('../lib/vault/daemon');
const { createClient } = require('../lib/vault/client');
const { createSecretsServer } = require('../lib/broker/mcp');
const policy = require('../lib/team/policy');
const fakeEngine = require('./helpers/fake_engine');
const { startFakeTeamServer } = require('./helpers/fake_team_server');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
const confirmations = [];
let answer = true;
const confirm = async (req) => { confirmations.push(req); return answer; };

let srv = null;
let cloud = null;
let vault = null;
const sent = [];

function mcp(agent) {
  return createSecretsServer({
    vault, engine: fakeEngine, agent, notify: () => {},
    fetch: async (url) => { sent.push(String(url)); return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }); },
  });
}

async function request(agent, marker, url) {
  const r = await mcp(agent).handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'secrets_http_request', arguments: { method: 'GET', url, headers: { Authorization: 'Bearer ' + marker } } } });
  return { isError: Boolean(r.result.isError), text: r.result.content[0].text };
}

test.before(async () => {
  const created = await keychain.initIdentity({ passphrase: 'correct horse battery staple', workFactor: 10 });
  srv = await daemon.serve({ identity: created.identity, ttlMs: 600000, idleMs: 600000, confirm, teamSyncMs: 0 });
  vault = createClient({});
  await vault.setSecret('PROD_DB_URL', 'postgres://u:' + 'p'.repeat(24) + '@db.internal/app', { mode: 'proxy', allowHosts: ['127.0.0.1'] });
  await vault.setSecret('STRIPE_KEY', 'sk_test_' + 'x'.repeat(24), { mode: 'proxy', allowHosts: ['api.stripe.com'] });
  cloud = await startFakeTeamServer();
});

test.after(async () => {
  if (vault) vault.close();
  if (srv) await srv.close();
  if (cloud) await cloud.close();
  fs.rmSync(HOME, { recursive: true, force: true });
});

test('join is confirmed outside the agent; declining sends nothing', async () => {
  answer = false;
  const token = cloud.createJoinToken({ maxUses: 5 });
  await assert.rejects(vault.teamJoin({ join_token: token, api_base: cloud.base, agent: 'claude-code' }), /declined/);
  assert.strictEqual(cloud.requests.filter((r) => r.path === '/v1/org/join').length, 0);
  answer = true;
  const r = await vault.teamJoin({ join_token: token, api_base: cloud.base, agent: 'claude-code' });
  assert.match(r.org, /^org_/);
  const asked = confirmations.filter((c) => c.kind === 'team');
  assert.ok(asked.length >= 2);
  assert.ok(asked[asked.length - 1].warnings.some((w) => /not the zn service/.test(w)));
  const team = policy.readTeam();
  assert.strictEqual(team.org, r.org);
  assert.ok(!fs.readFileSync(policy.paths().teamFile, 'utf8').includes('zni_'), 'the install token is not in team.json');
});

test('another server never gets the join token before the user confirms', async () => {
  const token = cloud.createJoinToken({ maxUses: 2 });
  const seen = cloud.requests.length;
  answer = false;
  const before = confirmations.length;
  await assert.rejects(vault.teamJoin({ join_token: token, api_base: cloud.base, agent: 'claude-code' }), /declined/);
  assert.strictEqual(cloud.requests.length, seen, 'no request at all before the dialog');
  const dialog = confirmations.slice(before).find((c) => c.kind === 'team');
  assert.ok(dialog.warnings.some((w) => /Could not check which organization/.test(w) && /api\.usezn\.com/.test(w)));
  assert.ok(!dialog.fields.some(([k]) => k === 'Organization'));
  answer = true;
});

test('a signed policy denies a secret for every agent, and the audit log is uploaded', async () => {
  cloud.publishPolicy({ rules: [
    { secret: 'PROD_*', agents: ['codex'], deny: true, reason: 'No production credentials in Codex' },
    { secret: 'STRIPE_KEY', agents: ['claude-code'], allowHosts: ['api.stripe.com', '127.0.0.1'] },
  ] });
  const s = await vault.teamSync({});
  assert.strictEqual(s.policy.status, 'updated');
  assert.strictEqual(s.upload.status, 'ok');
  const inst = [...cloud.state.installs.values()][0];
  assert.ok(inst.events.length > 0, 'audit records reached the server');
  assert.ok(inst.events.every((e) => !JSON.stringify(e).includes('pppppppp')), 'no secret value in uploaded records');

  const codex = await request('codex', '__ZN_PROD_DB_URL__', 'http://127.0.0.1:9/x');
  assert.strictEqual(codex.isError, true);
  assert.match(codex.text, /organization policy/);
  // The rule names Codex, but zn-gate cannot prove which agent calls: it applies to all.
  const before = sent.length;
  const claude = await request('claude-code', '__ZN_PROD_DB_URL__', 'http://127.0.0.1:9/x');
  assert.strictEqual(claude.isError, true);
  assert.strictEqual(sent.length, before);
});

test('a self-reported agent id (ZN_AGENT) cannot dodge a rule for another agent', async () => {
  const saved = process.env.ZN_AGENT;
  process.env.ZN_AGENT = 'claude-code';
  try {
    const r = await request(undefined, '__ZN_PROD_DB_URL__', 'http://127.0.0.1:9/x');
    assert.strictEqual(r.isError, true);
    assert.match(r.text, /organization policy/);
  } finally {
    if (saved === undefined) delete process.env.ZN_AGENT; else process.env.ZN_AGENT = saved;
  }
});

test('deleting or editing the policy file does not lift the restrictions', async () => {
  const file = policy.paths().policyFile;
  fs.rmSync(file);
  const gone = await request('codex', '__ZN_PROD_DB_URL__', 'http://127.0.0.1:9/x');
  assert.strictEqual(gone.isError, true);
  assert.match(gone.text, /organization policy/);
  fs.writeFileSync(file, '{"v":1,"envelope":{}}');
  const edited = await request('codex', '__ZN_PROD_DB_URL__', 'http://127.0.0.1:9/x');
  assert.strictEqual(edited.isError, true);
  // The next sync puts the readable copy back.
  await vault.teamSync({ upload: false });
  assert.strictEqual(policy.state().state, 'active');
});

test('a host the organization opens is used only after a local approval', async () => {
  const n = confirmations.length;
  answer = false;
  const no = await request('claude-code', '__ZN_STRIPE_KEY__', 'http://127.0.0.1:9/charge');
  assert.strictEqual(no.isError, true);
  assert.strictEqual(confirmations.length, n + 1);
  assert.strictEqual(confirmations[n].kind, 'policy');
  // Codex is not in the rule: nothing to approve, plain local denial.
  const codex = await request('codex', '__ZN_STRIPE_KEY__', 'http://127.0.0.1:9/charge');
  assert.strictEqual(codex.isError, true);
  assert.strictEqual(confirmations.length, n + 1);
  answer = true;
  const yes = await request('claude-code', '__ZN_STRIPE_KEY__', 'http://127.0.0.1:9/charge');
  assert.strictEqual(yes.isError, false, yes.text);
  // Approved once: no second question.
  await request('claude-code', '__ZN_STRIPE_KEY__', 'http://127.0.0.1:9/charge');
  assert.strictEqual(confirmations.length, n + 2);
});

test('approving something the policy does not ask for is refused', async () => {
  await assert.rejects(vault.confirmOrgOpening('STRIPE_KEY', 'host', 'evil.example.net', 'claude-code', true), /does not ask for this/);
  // A pending host, but asked for with a self-reported agent id.
  await assert.rejects(vault.confirmOrgOpening('STRIPE_KEY', 'host', '127.0.0.1', 'claude-code', false), /does not ask for this/);
  await assert.rejects(vault.confirmOrgOpening('STRIPE_KEY', 'command', 'stripe', 'claude-code', true), /invalid request/);
});

test('a forged policy is rejected and the last good one stays', async () => {
  const forged = cloud.signRaw({ org: 'org_Forged123456789', version: 99, issued_at: new Date().toISOString(), expires_at: new Date(Date.now() + 86400000).toISOString(), rules: [] });
  const acc = policy.accept(forged, null, {});
  assert.strictEqual(acc.ok, false);
  assert.strictEqual(policy.state().state, 'active');
});

test('offline: the cached policy keeps applying', async () => {
  const base = cloud.base;
  await cloud.close();
  const s = await vault.teamSync({});
  assert.strictEqual(s.policy.status, 'offline');
  const codex = await request('codex', '__ZN_PROD_DB_URL__', 'http://127.0.0.1:9/x');
  assert.strictEqual(codex.isError, true);
  cloud = await startFakeTeamServer();
  assert.notStrictEqual(cloud.base, base);
});

test('local OTLP export of the audit log works without an account', () => {
  const r = spawnSync(process.execPath, [CLI, 'vault', 'log', 'export', '--otlp'], { env: process.env, encoding: 'utf8', timeout: 30000 });
  assert.strictEqual(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.ok(lines.length >= 1);
  const first = JSON.parse(lines[0]);
  assert.strictEqual(first.resourceLogs[0].scopeLogs[0].logRecords[0].eventName, 'zn.gate.decision');
  const usage = spawnSync(process.execPath, [CLI, 'vault', 'log', 'export'], { env: process.env, encoding: 'utf8', timeout: 30000 });
  assert.strictEqual(usage.status, 2);
  assert.match(usage.stderr, /zn vault log export --otlp/);
});

test('zn team status shows the organization and never the token', async () => {
  const r = await zn(['team', 'status', '--json']);
  assert.strictEqual(r.status, 0, r.stderr);
  const s = JSON.parse(r.stdout);
  assert.strictEqual(s.joined, true);
  assert.strictEqual(s.vault, 'unlocked');
  assert.strictEqual(s.policy.state, 'active');
  assert.ok(!r.stdout.includes('zni_'));
});

test('leave is confirmed outside the agent and lifts the organization policy', async () => {
  answer = false;
  await assert.rejects(vault.teamLeave(), /declined/);
  assert.ok(policy.readTeam());
  answer = true;
  const r = await vault.teamLeave();
  assert.match(r.left, /^org_/);
  assert.strictEqual(policy.readTeam(), null);
  assert.ok(!fs.existsSync(policy.paths().policyFile));
  const codex = await request('codex', '__ZN_PROD_DB_URL__', 'http://127.0.0.1:9/x');
  assert.strictEqual(codex.isError, false, codex.text);
});
