'use strict';

// zn-gate stats: these tests must never count into the real ~/.zn/stats.json.
process.env.ZN_STATS = 'off';

// Team policy and the Gemini CLI adapter (experimental), through the real hook runner. Gemini CLI reaches the same
// verified policy as the other agents (no second verifier): the organization's detectors are applied to the arguments
// of an MCP call, an invalid or edited policy is never trusted, and no policy leaves the behaviour unchanged.
// The "secrets" MCP server `hooks install gemini` registers is what lets the vault side of the policy apply.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-gemini-team-'));
process.env.ZN_HOME = path.join(HOME, '.zn');

const gemini = require('../lib/agents/gemini');
const policy = require('../lib/team/policy');
const { createFakeVault } = require('./helpers/fake_vault');

const ORG = 'org_TestOrg12345678';
const ACME = 'ACME-' + 'K7Q2ZP4M9XW3LB8RT5VN6YC1'; // fake
const DETECTOR = { id: 'acme', pattern: 'ACME-[A-Z0-9]{24}', type: 'ACME_TOKEN' };
const keys = crypto.generateKeyPairSync('ed25519');
const der = keys.publicKey.export({ format: 'der', type: 'spki' });
const KEY = der.subarray(der.length - 32).toString('base64url');
const PIN = { alg: 'Ed25519', kid: policy.kidOf(KEY), key: KEY };
const PROJECT = fs.mkdtempSync(path.join(HOME, 'project-'));
spawnSync('git', ['init', '-q'], { cwd: PROJECT });

test.after(() => fs.rmSync(HOME, { recursive: true, force: true }));
test.beforeEach(() => {
  fs.rmSync(process.env.ZN_HOME, { recursive: true, force: true });
  fs.mkdirSync(process.env.ZN_HOME, { recursive: true });
});

function envelope(version, extra) {
  const now = Date.now();
  const p = Object.assign({ org: ORG, version, issued_at: new Date(now - 1000).toISOString(), expires_at: new Date(now + 86400000).toISOString(), rules: [], detectors: [DETECTOR] }, extra || {});
  const sig = crypto.sign(null, Buffer.from(policy.canonicalJson(p), 'utf8'), keys.privateKey).toString('base64url');
  return { policy: p, signature: { alg: 'Ed25519', kid: PIN.kid, sig } };
}

function writeTeam() {
  policy.writeTeam({ org: ORG, api_base: 'https://api.usezn.com', install_id: crypto.randomUUID(), policy_public_key: PIN });
}

/* The hook module keeps the compiled detectors for the life of the process: a fresh copy per case. */
function freshRunner() {
  delete require.cache[require.resolve('../lib/hooks/runner')];
  return require('../lib/hooks/runner');
}

const mcpCall = (args) => ({
  session_id: 's', cwd: PROJECT, hook_event_name: 'BeforeTool', tool_name: 'mcp_demo_send', tool_input: args,
  mcp_context: { server_name: 'demo', tool_name: 'send' },
});

async function run(vault, raw) {
  const runner = freshRunner();
  return runner.handle(gemini, raw, { vault, failMode: 'open' });
}

const denied = (r) => r.output && r.output.decision === 'deny';

test('a verified Team policy: a Team detector blocks an MCP call that would send the value', async () => {
  writeTeam();
  policy.writeCache(envelope(1));
  const r = await run(createFakeVault(), mcpCall({ body: 'token ' + ACME }));
  assert.ok(denied(r), JSON.stringify(r.output));
  assert.match(r.output.reason, /acme/i);
});

test('no Team policy: the same call is left alone (unchanged behaviour)', async () => {
  const r = await run(createFakeVault(), mcpCall({ body: 'token ' + ACME }));
  assert.ok(!denied(r), JSON.stringify(r.output));
});

test('a policy that does not verify is not trusted: no detector of it is applied (fails closed on the policy)', async () => {
  writeTeam();
  const env = envelope(1);
  // Edited after signing: the signature no longer matches.
  env.policy.detectors = [{ id: 'evil', pattern: 'x{4}', type: 'EVIL' }, DETECTOR];
  policy.writeCache(env);
  const r1 = await run(createFakeVault(), mcpCall({ body: 'xxxx' }));
  assert.ok(!denied(r1), 'the edited detector is not applied');
  const r2 = await run(createFakeVault(), mcpCall({ body: ACME }));
  assert.ok(!denied(r2), 'the signed detector inside an edited file is not applied either');
});

test('a policy signed by another key is not trusted', async () => {
  writeTeam();
  const other = crypto.generateKeyPairSync('ed25519');
  const env = envelope(1);
  env.signature.sig = crypto.sign(null, Buffer.from(policy.canonicalJson(env.policy), 'utf8'), other.privateKey).toString('base64url');
  policy.writeCache(env);
  assert.ok(!denied(await run(createFakeVault(), mcpCall({ body: ACME }))));
});

test('an invalid policy held by the vault leaves the same state as for the other agents: the vault side blocks, no detector applies', async () => {
  const vault = Object.assign(createFakeVault(), {
    teamHookInfo: async () => ({ joined: true, org: ORG, state: 'invalid', version: null, detectors: [], change: null }),
  });
  assert.ok(!denied(await run(vault, mcpCall({ body: ACME }))));
});

/* ---------------- the "secrets" MCP server ---------------- */

function settings(home) { return path.join(home, '.gemini', 'settings.json'); }
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

function installAt(home, opts) {
  return gemini.install({ home, nodePath: process.execPath, platform: 'linux', ...(opts || {}) });
}

test('install registers zn\'s secrets MCP server for this agent, and uninstall removes only that', () => {
  const home = fs.mkdtempSync(path.join(HOME, 'home-'));
  const rep = installAt(home);
  assert.equal(rep.mcp, settings(home));
  const s = readJson(settings(home));
  assert.equal(s.mcpServers.secrets.command, process.execPath);
  assert.deepEqual(s.mcpServers.secrets.args.slice(1), ['secrets-mcp', '--agent', 'gemini']);
  assert.ok(Array.isArray(s.hooks.BeforeTool));
  gemini.uninstall({ home });
  assert.equal(fs.existsSync(settings(home)) ? readJson(settings(home)).mcpServers : undefined, undefined);
});

test('a server named secrets that is not zn\'s is left unchanged, and mcp: false registers nothing', () => {
  const home = fs.mkdtempSync(path.join(HOME, 'home-'));
  fs.mkdirSync(path.join(home, '.gemini'));
  const theirs = { command: 'their-server', args: ['--flag'] };
  fs.writeFileSync(settings(home), JSON.stringify({ mcpServers: { secrets: theirs, other: { command: 'x' } } }));
  const rep = installAt(home);
  assert.equal(rep.mcp, undefined);
  assert.ok(rep.warnings.some((w) => /already exists/.test(w)));
  assert.deepEqual(readJson(settings(home)).mcpServers.secrets, theirs);
  gemini.uninstall({ home });
  assert.deepEqual(readJson(settings(home)).mcpServers, { secrets: theirs, other: { command: 'x' } });
  const home2 = fs.mkdtempSync(path.join(HOME, 'home-'));
  installAt(home2, { mcp: false });
  assert.equal(readJson(settings(home2)).mcpServers, undefined);
});

test('a project install writes no MCP server (hint only)', () => {
  const home = fs.mkdtempSync(path.join(HOME, 'home-'));
  const proj = fs.mkdtempSync(path.join(HOME, 'proj-'));
  const rep = gemini.install({ home, scope: 'project', projectDir: proj, platform: 'linux' });
  assert.equal(rep.mcp, undefined);
  assert.equal(readJson(path.join(proj, '.gemini', 'settings.json')).mcpServers, undefined);
  assert.ok(rep.warnings.some((w) => /"secrets" MCP server/.test(w)));
});

test('a call to the secrets server is recognised as zn\'s only for the installed user entry, and a project entry of the same name cancels it', () => {
  const home = fs.mkdtempSync(path.join(HOME, 'home-'));
  const empty = path.join(HOME, 'no-system.json');
  installAt(home);
  const raw = { session_id: 's', cwd: PROJECT, hook_event_name: 'BeforeTool', tool_name: 'mcp_secrets_secrets_list', tool_input: {}, mcp_context: { server_name: 'secrets', tool_name: 'secrets_list' } };
  const o = { home, systemSettings: empty };
  assert.equal(gemini.normalize(raw, o).mcp.ours, 'secrets');
  // Not one of the server's tools: never ours.
  assert.equal(gemini.normalize({ ...raw, tool_name: 'mcp_secrets_other', mcp_context: { server_name: 'secrets', tool_name: 'other' } }, o).mcp.ours, undefined);
  // A project settings file that defines the name: the project wins in Gemini CLI, so nothing is trusted.
  fs.mkdirSync(path.join(PROJECT, '.gemini'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT, '.gemini', 'settings.json'), JSON.stringify({ mcpServers: { secrets: { command: 'evil' } } }));
  assert.equal(gemini.normalize(raw, o).mcp.ours, undefined);
  // An unreadable project file: not trusted either.
  fs.writeFileSync(path.join(PROJECT, '.gemini', 'settings.json'), '{ not json');
  assert.equal(gemini.normalize(raw, o).mcp.ours, undefined);
  fs.rmSync(path.join(PROJECT, '.gemini'), { recursive: true, force: true });
  assert.equal(gemini.normalize(raw, o).mcp.ours, 'secrets');
  // No zn entry in the user settings: not ours.
  const bare = fs.mkdtempSync(path.join(HOME, 'home-'));
  assert.equal(gemini.normalize(raw, { home: bare, systemSettings: empty }).mcp.ours, undefined);
});

test('a call to another MCP server is not changed by any of this', () => {
  const m = gemini.normalize({ hook_event_name: 'BeforeTool', cwd: PROJECT, tool_name: 'mcp_sql_query', tool_input: { q: 'x' } });
  assert.deepEqual(m.mcp, { server: 'sql', tool: 'query' });
});
