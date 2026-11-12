'use strict';
/*
 * zn Team after joining, with no network. The machine joins a local fake
 * server (a real vault daemon, confirmed outside the agent), then the server
 * goes away (closed port) or name lookup fails (simulated resolver error).
 * Checks, against docs/team.md "Offline, expiry and removal":
 *   - `zn team sync` says plainly that the server could not be reached, exits 1,
 *     keeps the cached policy byte for byte and leaves the audit records queued;
 *   - `zn team status` shows the failed sync, the last success and the policy expiry;
 *   - a hook with a valid cached policy applies it and answers within 1.5 s;
 *   - once the cached policy expired (offline longer than its validity), strict
 *     mode: restrictions and detectors stay, openings are withdrawn.
 */
process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-team-offline-'));
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
      { secret: 'PROD_*', agents: ['codex'], deny: true, reason: 'No production credentials in Codex' },
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

const policyFile = () => policy.paths().policyFile;
let cachedBytes = null;
let pendingBefore = 0;

test('baseline: joined, policy cached, online hook applies the detector', async () => {
  const s = await statusJson();
  assert.strictEqual(s.joined, true);
  assert.strictEqual(s.policy.state, 'active');
  cachedBytes = read(policyFile());
  const h = await hookInProcess();
  assert.ok(h.redacted, 'the organization detector is applied');
});

test('closed port: zn team sync says the server was not reached, exits 1, keeps the policy and queues the audit', async () => {
  // New audit records that cannot go anywhere.
  await vault.setSecret('QUEUE_PROBE', 'qp_' + 'z'.repeat(24), { mode: 'env' });
  const auditBefore = audit();
  pendingBefore = (await statusJson()).upload.pending;
  assert.ok(pendingBefore > 0, 'there are records waiting to be uploaded');
  await cloud.close(); // the port stays in team.json and now refuses connections
  const r = await run(['team', 'sync']);
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /Could not reach the zn server\. Nothing was changed\./);
  assert.match(r.stderr, /zn team sync/);
  assert.doesNotMatch(r.stdout + r.stderr, /Policy: (updated|current)/);
  assert.ok(!/ECONNREFUSED|stack|at .*\.js:\d+/.test(r.stdout + r.stderr), 'no raw error in the default output');
  assert.ok(r.ms < 8000, 'fails fast on a closed port: ' + r.ms + ' ms');
  assert.strictEqual(read(policyFile()), cachedBytes, 'the cached policy file is untouched');
  assert.strictEqual(policy.state().state, 'active');
  assert.ok(audit().startsWith(auditBefore), 'audit records are kept');
  assert.ok((await statusJson()).upload.pending >= pendingBefore, 'nothing was dropped from the queue');
});

test('closed port: zn team status says the last sync failed, when it last worked and until when the policy is valid', async () => {
  const r = await run(['team', 'status']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /Policy:\s+version \d+, valid until \d{4}-\d\d-\d\dT/);
  assert.match(r.stdout, /Last sync:\s+FAILED \d{4}-\d\d-\d\dT[^:]*:?.*could not reach the zn server/);
  assert.match(r.stdout, /\(last success \d{4}-\d\d-\d\dT/);
  assert.match(r.stdout, /run `zn team sync` to retry/);
  assert.match(r.stdout, /\d+ records pending/);
  const j = JSON.parse((await run(['team', 'status', '--json'])).stdout);
  assert.strictEqual(j.last_sync.ok, false);
  assert.ok(j.last_sync.last_ok_at, 'the last success is kept');
  assert.strictEqual(j.policy.state, 'active');
});

test('simulated DNS failure: same message, exit 1, policy untouched', async () => {
  // A fresh server for the same org would change the port; only the resolver is replaced here.
  netMode = 'dns';
  try {
    const r = await run(['team', 'sync']);
    assert.strictEqual(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /Could not reach the zn server\. Nothing was changed\./);
    assert.ok(!/EAI_AGAIN/.test(r.stdout + r.stderr), 'the technical cause shows only with ZN_VERBOSE=1');
    assert.strictEqual(read(policyFile()), cachedBytes);
    const s = await run(['team', 'status']);
    assert.match(s.stdout, /Last sync:\s+FAILED/);
  } finally { netMode = 'real'; }
});

test('failed syncs write one audit alert, not one per attempt', async () => {
  await run(['team', 'sync']);
  await run(['team', 'sync']);
  const alerts = audit().trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.reason === 'team_sync_failed');
  assert.strictEqual(alerts.length, 1, 'documented: one record, then at most one more every 6 hours');
});

test('hook with a valid cached policy and no network: applies it and answers within 1.5 s', async () => {
  const h = await hookInProcess();
  assert.ok(h.redacted, 'the cached detector is applied');
  assert.ok(h.ms < HOOK_LIMIT_MS, 'hook took ' + h.ms + ' ms');
  const event = JSON.stringify(postEvent('export INTERNAL=' + ACME + '\n'));
  const child = await run(['hook', 'claude-code'], event);
  assert.strictEqual(child.status, 0, child.stderr);
  assert.ok(child.ms < HOOK_LIMIT_MS + 1500, 'a whole hook process (node start included) took ' + child.ms + ' ms');
  assert.ok(!child.stdout.includes(ACME), 'the token does not come back: ' + child.stdout);
  // The restriction applies too.
  const codex = await request('codex', '__ZN_PROD_DB_URL__', 'http://127.0.0.1:9/x');
  assert.strictEqual(codex.isError, true);
  assert.match(codex.text, /organization policy/);
});

test('policy expired and no network: strict mode, restrictions and detectors stay, openings are withdrawn', async () => {
  const opened = () => request('claude-code', '__ZN_STRIPE_KEY__', 'http://127.0.0.1:9/charge');
  // While valid, the opening is offered for a local approval.
  const n = confirmations.length;
  await opened();
  assert.ok(confirmations.length > n, 'valid policy: the opening asks for approval');
  const exp = Date.parse(policy.state().expires_at);
  Date.now = () => exp + 2 * DAY; // offline for longer than the policy's validity
  try {
    const st = await run(['team', 'status']);
    assert.strictEqual(st.status, 0, st.stderr);
    assert.match(st.stdout, /EXPIRED: strict mode/);
    assert.strictEqual((await statusJson()).policy.state, 'expired');
    const sync = await run(['team', 'sync']);
    assert.strictEqual(sync.status, 1);
    assert.match(sync.stderr, /Could not reach the zn server/);
    // Restrictions keep applying.
    const codex = await request('codex', '__ZN_PROD_DB_URL__', 'http://127.0.0.1:9/x');
    assert.strictEqual(codex.isError, true);
    assert.match(codex.text, /organization policy/);
    // The detector keeps applying in the hook.
    const h = await hookInProcess();
    assert.ok(h.redacted, 'detectors stay in strict mode');
    // The opening is withdrawn: no approval is offered any more.
    const before = confirmations.length;
    const strict = await opened();
    assert.strictEqual(strict.isError, true);
    assert.strictEqual(confirmations.length, before, 'no approval dialog for a withdrawn opening');
  } finally { Date.now = realNow; }
});
