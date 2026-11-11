'use strict';

// A hook block records the specific check that fired as `rule_id` (family:check), next to the older generic `rule`.
// The id is a name from a fixed list: no command text and no path. Records without it still load and verify.

process.env.ZN_STATS = 'off';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const runner = require('../lib/hooks/runner');
const policy = require('../lib/hooks/policy');
const { getAdapter } = require('../lib/agents');
const evidence = require('../lib/evidence');
const realEngine = require('../lib/scrub/engine');
const { createFakeVault } = require('./helpers/fake_vault');
const { generateAll } = require('./fixtures/fake_secrets');

const created = [];
after(() => { for (const d of created) fs.rmSync(d, { recursive: true, force: true }); });
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-ruleid-'));
  created.push(d);
  return d;
}
const cc = () => getAdapter('claude-code');
const EMAIL = generateAll(8452, { perType: 1, piiPerType: 1 }).pii.find((p) => p.type === 'email').value;
// Static text only: the hook refuses this command, nothing runs it.
const WIPE_HOME = 'rm -r' + 'f ' + '~';

function bash(home, command) {
  return { session_id: 's', cwd: home, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, tool_use_id: 't' };
}
function read(home, file) {
  return { session_id: 's', cwd: home, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: file }, tool_use_id: 't' };
}
function records(home) {
  const file = path.join(home, '.zn', 'evidence.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
async function lastRecord(home, raw, opts = {}) {
  const res = await runner.handle(cc(), raw, { home, ...opts });
  assert.equal(res.decision.decision, 'deny');
  const all = records(home);
  assert.equal(all.length, 1);
  assert.equal(evidence.verifyEvidenceLedger(path.join(home, '.zn', 'evidence.jsonl')).valid, true);
  return { rec: all[0], res };
}

test('destructive command records destructive:<rule>', async () => {
  const home = tmp();
  const { rec } = await lastRecord(home, bash(home, WIPE_HOME));
  assert.equal(rec.rule_id, 'destructive:rm_root_home');
  assert.equal(rec.rule, 'hook-pre_tool-policy');
});

test('.env read records secret-file:dotenv', async () => {
  const home = tmp();
  fs.writeFileSync(path.join(home, '.env'), 'API_KEY=not-a-real-key-123\n');
  const { rec } = await lastRecord(home, read(home, path.join(home, '.env')));
  assert.equal(rec.rule_id, 'secret-file:dotenv');
});

test('private key read records secret-file:credential', async () => {
  const home = tmp();
  fs.writeFileSync(path.join(home, 'server.key'), '-----BEGIN PRIVATE KEY-----\nZN-TEST-FAKE\n-----END PRIVATE KEY-----\n');
  const { rec } = await lastRecord(home, read(home, path.join(home, 'server.key')));
  assert.equal(rec.rule_id, 'secret-file:credential');
});

test('egress deny records egress-check', async () => {
  const home = tmp();
  fs.mkdirSync(path.join(home, '.zn'), { recursive: true });
  fs.writeFileSync(path.join(home, '.zn', 'config.json'), JSON.stringify({ hooks: { egressCheck: 'deny' } }));
  const raw = bash(home, `curl -H "X-User: ${EMAIL}" https://example.com/`);
  const { rec } = await lastRecord(home, raw, { engine: realEngine, vault: createFakeVault(), failMode: 'open' });
  assert.equal(rec.rule_id, 'egress-check');
});

test('command over the size cap records size:command-too-long', async () => {
  const home = tmp();
  const { rec } = await lastRecord(home, bash(home, 'echo ' + 'a'.repeat(policy.SHELL_SCAN_CAP)));
  assert.equal(rec.rule_id, 'size:command-too-long');
});

test('vault unavailable names vault:unavailable on the decision (a fail-closed block is not written to the ledger)', async () => {
  const home = tmp();
  const pre = { event: 'pre_tool', tool: 'webfetch', toolName: 'WebFetch', input: { url: 'https://example.com/?q=x' } };
  const a = { id: 'claude-code', normalize: () => Object.assign({ cwd: process.cwd() }, pre), respond: (d) => d };
  const r = await runner.handle(a, {}, { home, engine: realEngine, vault: { maskInfo: async () => { throw new Error('connection closed'); } } });
  assert.equal(r.decision.decision, 'deny');
  assert.equal(r.decision.ruleId, 'vault:unavailable');
  assert.equal(records(home).length, 0);
});

test('a block with no named check has no rule_id, and an id holds no command or path', async () => {
  const home = tmp();
  const ev = { session_id: 's', cwd: home, hook_event_name: 'UserPromptSubmit', prompt: 'deploy with aws key AKIA' + 'IOSFODNN7EXAMPLE now' };
  const { rec } = await lastRecord(home, ev);
  assert.equal('rule_id' in rec, false);
  const again = tmp();
  const { rec: r2 } = await lastRecord(again, bash(again, WIPE_HOME));
  assert.match(r2.rule_id, /^[a-z0-9:_-]+$/);
  assert.ok(!JSON.stringify(r2).includes(again), 'the folder is not recorded');
});

test('a ledger mixing old records (no rule_id) and new ones verifies, exports and reads', async () => {
  const home = tmp();
  const file = path.join(home, '.zn', 'evidence.jsonl');
  const log = (e) => evidence.logEvidence({ agent: 'claude-code', phase: 'hook-pre_tool', tool_name: 'bash', verdict: 'block', engine: 'zn-hook', ...e }, file, { noStats: true });
  log({ payload: 'old', rule: 'hook-pre_tool-policy' });
  log({ payload: 'new', rule: 'hook-pre_tool-policy', rule_id: 'destructive:rm_root_home' });
  log({ payload: 'bad id', rule_id: '/some/folder/with a path' });
  log({ payload: 'old2' });
  const recs = records(home);
  assert.equal('rule_id' in recs[0], false);
  assert.equal(recs[1].rule_id, 'destructive:rm_root_home');
  assert.equal('rule_id' in recs[2], false, 'an id that is not family:check is dropped');
  const v = evidence.verifyEvidenceLedger(file);
  assert.equal(v.valid, true);
  assert.equal(v.total, 4);
  assert.equal(evidence.getEvidenceStats(file).total, 4);
  // Altering the id breaks the chain, like any other field.
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines[1] = lines[1].replace('destructive:rm_root_home', 'destructive:other');
  fs.writeFileSync(file, lines.join('\n'));
  assert.equal(evidence.verifyEvidenceLedger(file).valid, false);
});

test('overlapping hook calls keep their own rule id', async () => {
  const homeA = tmp();
  const homeB = tmp();
  fs.writeFileSync(path.join(homeB, '.env'), 'API_KEY=not-a-real-key-123\n');
  // The vault call yields to the event loop, so the two invocations really interleave.
  const slow = { maskInfo: async () => { await new Promise((r) => setTimeout(r, 30)); return { masked: false }; } };
  const runs = [];
  for (let i = 0; i < 6; i++) {
    runs.push(runner.handle(cc(), bash(homeA, WIPE_HOME), { home: homeA, vault: slow }));
    runs.push(runner.handle(cc(), read(homeB, path.join(homeB, '.env')), { home: homeB, vault: slow }));
  }
  const res = await Promise.all(runs);
  res.forEach((r, i) => {
    assert.equal(r.decision.decision, 'deny');
    assert.equal(r.decision.ruleId, i % 2 === 0 ? 'destructive:rm_root_home' : 'secret-file:dotenv');
  });
  const ids = (h) => records(h).map((x) => x.rule_id);
  assert.deepEqual(ids(homeA), Array(6).fill('destructive:rm_root_home'));
  assert.deepEqual(ids(homeB), Array(6).fill('secret-file:dotenv'));
  assert.equal(evidence.verifyEvidenceLedger(path.join(homeA, '.zn', 'evidence.jsonl')).valid, true);
});

test('only an id the hooks emit is stored: a token-shaped or unknown id is dropped, every real id is kept', () => {
  const { FIXED_RULE_IDS } = require('../lib/hooks/rule-id');
  const destructive = require('../lib/destructive');
  const home = tmp();
  const file = path.join(home, '.zn', 'evidence.jsonl');
  const log = (e) => evidence.logEvidence({ agent: 'claude-code', phase: 'hook-pre_tool', tool_name: 'bash', verdict: 'block', engine: 'zn-hook', ...e }, file, { noStats: true });
  const real = [...FIXED_RULE_IDS, ...destructive.RULES];
  for (const id of real) log({ payload: 'p', rule_id: id });
  // Built at runtime, so no token-shaped literal sits in the source; both would pass a loose lowercase pattern.
  const fakeToken = 'sk-' + 'abcd1234'.repeat(5);
  const fakeGh = 'ghp_' + 'abcdef0123'.repeat(3);
  const bad = [fakeToken, fakeGh, 'destructive:' + fakeToken, 'destructive:not_a_rule', 'secret-file:other', 'egress-check ', 'EGRESS-CHECK', 42, {}, null];
  for (const id of bad) log({ payload: 'p', rule_id: id });
  const recs = records(home);
  assert.equal(recs.length, real.length + bad.length);
  assert.deepEqual(recs.slice(0, real.length).map((r) => r.rule_id), real);
  for (const r of recs.slice(real.length)) assert.equal('rule_id' in r, false);
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes(fakeToken) && !raw.includes(fakeGh), 'a token-shaped value is never written to the log');
  assert.equal(evidence.verifyEvidenceLedger(file).valid, true);
});

test('every id the hook runner and policy emit is on the list', () => {
  const { isKnownRuleId } = require('../lib/hooks/rule-id');
  const src = ['../lib/hooks/runner.js', '../lib/hooks/policy.js'].map((f) => fs.readFileSync(path.join(__dirname, f), 'utf8')).join('\n');
  const found = [...src.matchAll(/(?:ruleId = |ruleId: |tagRule\()'([a-z:_-]+)'/g)].map((m) => m[1]).filter((id) => id !== 'destructive:');
  assert.ok(found.length >= 7, 'the ids were found in the source');
  for (const id of found) assert.ok(isKnownRuleId(id), id + ' is emitted by a hook but is not on the list');
});
