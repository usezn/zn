'use strict';
/*
 * zn Team when the organization has no active Team subscription (the policy download answers 402), end to end with a
 * real vault daemon. The last policy keeps applying until it expires, then strict mode; `zn team status` and the
 * block message say why and who to ask; a successful download clears it. A 402 never lifts a restriction.
 */
process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-team-nosub-'));
process.env.ZN_HOME = path.join(HOME, '.zn');
process.env.ZN_KEYCHAIN_BACKEND = 'passphrase';

const keychain = require('../lib/vault/keychain');
const daemon = require('../lib/vault/daemon');
const { createClient } = require('../lib/vault/client');
const { createSecretsServer } = require('../lib/broker/mcp');
const policy = require('../lib/team/policy');
const adapter = require('../lib/agents/claude-code');
const fakeEngine = require('./helpers/fake_engine');
const { startFakeTeamServer } = require('./helpers/fake_team_server');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
const DAY = 86400000;
const HOOK_LIMIT_MS = 1500;
const ACME = 'ACME-' + 'K7Q2ZP4M9XW3LB8RT5VN6YC1';
const DETECTOR = { id: 'acme', pattern: 'ACME-[A-Z0-9]{24}', type: 'ACME_TOKEN' };

/* Async: the vault daemon runs in this process and must keep answering. */
function run(args, input) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const c = spawn(process.execPath, [CLI, ...args], { env: process.env });
    let stdout = '';
    let stderr = '';
    c.stdout.on('data', (d) => { stdout += d; });
    c.stderr.on('data', (d) => { stderr += d; });
    c.on('close', (status) => resolve({ status, stdout, stderr, ms: Date.now() - t0 }));
    c.stdin.end(input || '');
  });
}

/* What the daemon's HTTP client sees: the real network, or a resolver that fails like a machine with no DNS. */
let netMode = 'real';
const fetchImpl = (url, opts) => {
  if (netMode === 'dns') {
    const e = new TypeError('fetch failed');
    e.cause = Object.assign(new Error('getaddrinfo EAI_AGAIN api.example.invalid'), { code: 'EAI_AGAIN', syscall: 'getaddrinfo', hostname: 'api.example.invalid' });
    return Promise.reject(e);
  }
  return fetch(url, opts);
};

const confirmations = [];
const confirm = async (req) => { confirmations.push(req); return true; };

let srv = null;
let cloud = null;
let vault = null;
const realNow = Date.now;
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

const read = (f) => fs.readFileSync(f, 'utf8');
const audit = () => read(require('../lib/vault/store').paths().auditFile);
const statusJson = async () => JSON.parse((await run(['team', 'status', '--json'])).stdout);

function postEvent(text) {
  return {
    session_id: 's', cwd: HOME, permission_mode: 'default', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'env' },
    tool_response: { stdout: text, stderr: '', interrupted: false, isImage: false }, tool_use_id: 'toolu_1',
  };
}
/* The hook module keeps the compiled detectors for the life of the process: a fresh copy per case. */
async function hookInProcess() {
  delete require.cache[require.resolve('../lib/hooks/runner')];
  const runner = require('../lib/hooks/runner');
  const t0 = realNow();
  const res = await runner.handle(adapter, postEvent('export INTERNAL=' + ACME + '\n'), { vault, failMode: 'open' });
  const out = res.output && res.output.hookSpecificOutput;
  return { ms: realNow() - t0, redacted: Boolean(out && out.updatedToolOutput && !out.updatedToolOutput.stdout.includes(ACME)) };
}

test.before(async () => {
  const created = await keychain.initIdentity({ passphrase: 'correct horse battery staple', workFactor: 10 });
  // Long lifetimes: the expiry case moves the clock forward by more than a week.
  srv = await daemon.serve({ identity: created.identity, ttlMs: 2147483000, idleMs: 2147483000, confirm, teamSyncMs: 0, fetchImpl });
  vault = createClient({});
  await vault.setSecret('PROD_DB_URL', 'postgres://u:' + 'p'.repeat(24) + '@db.internal/app', { mode: 'proxy', allowHosts: ['127.0.0.1'] });
  await vault.setSecret('STRIPE_KEY', 'sk_test_' + 'x'.repeat(24), { mode: 'proxy', allowHosts: ['api.stripe.com'] });
  cloud = await startFakeTeamServer();
  cloud.publishPolicy({
    rules: [
      { secret: 'PROD_*', agents: ['codex', 'cursor'], deny: true, reason: 'No production credentials in Codex' },
      { secret: 'STRIPE_KEY', agents: ['claude-code'], allowHosts: ['api.stripe.com', '127.0.0.1'] },
    ],
    detectors: [DETECTOR],
  });
  const token = cloud.createJoinToken({ maxUses: 5 });
  const joined = await vault.teamJoin({ join_token: token, api_base: cloud.base, agent: 'claude-code' });
  assert.match(joined.org, /^org_/);
  // Online and in sync: policy downloaded, audit queue empty.
  await vault.teamSync({});
});

test.after(async () => {
  Date.now = realNow;
  if (vault) vault.close();
  if (srv) await srv.close();
  if (cloud) await cloud.close();
  fs.rmSync(HOME, { recursive: true, force: true });
});


test('402: sync says so, the flag is shown by status, the last policy still restricts and the cached copy is kept', async () => {
  const bytes = fs.readFileSync(policy.paths().policyFile);
  cloud.setOrgActive(false);
  const sync = await run(['team', 'sync']);
  assert.strictEqual(sync.status, 1);
  assert.match(sync.stderr, /sync incomplete: the organization's Team subscription is not active: the last policy applies until it expires, then strict mode\. Ask your organization owner or admin/);
  assert.ok(fs.readFileSync(policy.paths().policyFile).equals(bytes), 'the cached policy is untouched');
  const st = await run(['team', 'status']);
  assert.strictEqual(st.status, 0, st.stderr);
  assert.match(st.stdout, /^Subscription: NOT ACTIVE \(the server said so on \d{4}-\d\d-\d\dT[\d:.]+Z\)\. Your organization's Team subscription is not active\. The last policy applies until \d{4}-\d\d-\d\dT[\d:.]+Z; after that this machine is in strict mode \(only restrictions apply; nothing the organization opened stays open\)\. Ask your organization owner or admin\.$/m);
  const j = await statusJson();
  assert.strictEqual(j.policy.state, 'active');
  assert.ok(j.policy.subscription_inactive_at);
  const r = await request('codex', '__ZN_PROD_DB_URL__', 'http://127.0.0.1:9/x');
  assert.strictEqual(r.isError, true, '402 does not lift the deny');
  assert.match(r.text, /organization policy/);
  assert.doesNotMatch(r.text, /strict mode/, 'not in strict mode yet: no strict-mode note');
});

test('402 and the policy expired: strict mode, status and the block message name the cause and who to ask', async () => {
  const exp = Date.parse(policy.state().expires_at);
  Date.now = () => exp + 2 * DAY;
  try {
    const sync = await run(['team', 'sync']);
    assert.strictEqual(sync.status, 1);
    const st = await run(['team', 'status']);
    assert.match(st.stdout, /EXPIRED: strict mode \(only restrictions apply; nothing the organization opened stays open\) because your organization's Team subscription is not active\. Ask your organization owner or admin\./);
    assert.doesNotMatch(st.stdout, /check its date and time/);
    assert.strictEqual((await statusJson()).policy.state, 'expired');
    const note = /This machine is in strict mode because your organization's Team subscription is not active and its last policy expired\. Ask your organization owner or admin\./;
    // The restriction still applies and its message names the cause.
    const denied = await request('codex', '__ZN_PROD_DB_URL__', 'http://127.0.0.1:9/x');
    assert.strictEqual(denied.isError, true);
    assert.match(denied.text, note);
    // The opening the policy had offered is withdrawn: blocked, with the same note.
    const before = confirmations.length;
    const strict = await request('claude-code', '__ZN_STRIPE_KEY__', 'http://127.0.0.1:9/charge');
    assert.strictEqual(strict.isError, true);
    assert.match(strict.text, note);
    assert.strictEqual(confirmations.length, before);
  } finally { Date.now = realNow; }
});

test('the next successful download clears the flag and the messages', async () => {
  cloud.setOrgActive(true);
  const sync = await run(['team', 'sync']);
  assert.strictEqual(sync.status, 0, sync.stderr);
  const st = await run(['team', 'status']);
  assert.doesNotMatch(st.stdout, /Subscription:|subscription is not active/);
  assert.ok(!(await statusJson()).policy.subscription_inactive_at);
  const r = await request('codex', '__ZN_PROD_DB_URL__', 'http://127.0.0.1:9/x');
  assert.doesNotMatch(r.text, /Team subscription/);
});
