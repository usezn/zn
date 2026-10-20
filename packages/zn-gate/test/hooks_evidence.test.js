'use strict';

// A hook block lands in the hash-chained evidence ledger (agent, event, rule, secret kinds),
// never with a value, a command or a path, and a ledger problem never turns a block into an allow.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const runner = require('../lib/hooks/runner');
const { getAdapter } = require('../lib/agents');
const { verifyEvidenceLedger } = require('../lib/evidence');

const created = [];
after(() => { for (const d of created) fs.rmSync(d, { recursive: true, force: true }); });
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-hookev-'));
  created.push(d);
  return d;
}
const cc = () => getAdapter('claude-code');
const FAKE = 'AKIA' + 'IOSFODNN7EXAMPLE';

function pre(home, command) {
  return { session_id: 's', cwd: home, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, tool_use_id: 't' };
}
function ledger(home) {
  const file = path.join(home, '.zn', 'evidence.jsonl');
  if (!fs.existsSync(file)) return { file, records: [] };
  return { file, records: fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) };
}

test('a PreToolUse deny writes one ledger event and the chain verifies', async () => {
  const home = tmp();
  const res = await runner.handle(cc(), pre(home, 'cat ~/.aws/credentials'), { home });
  assert.equal(res.decision.decision, 'deny');
  const { file, records } = ledger(home);
  assert.equal(records.length, 1);
  const r = records[0];
  assert.equal(r.agent_environment, 'claude-code');
  assert.equal(r.verdict, 'block');
  assert.equal(r.rule, 'hook-pre_tool-policy');
  assert.equal(r.tool_name, 'bash');
  assert.equal(r.phase, 'hook-pre_tool');
  const text = JSON.stringify(r);
  assert.ok(!text.includes('credentials'), 'the command or path is not recorded');
  assert.ok(!text.includes('.aws'));
  const v = verifyEvidenceLedger(file);
  assert.equal(v.valid, true);
  assert.equal(v.total, 1);
});

test('an allow writes nothing', async () => {
  const home = tmp();
  const res = await runner.handle(cc(), pre(home, 'npm test'), { home });
  assert.equal(res.decision.decision, 'allow');
  assert.equal(ledger(home).records.length, 0);
});

test('a prompt with a secret is recorded by kind, never by value or text', async () => {
  const home = tmp();
  const ev = { session_id: 's', cwd: home, hook_event_name: 'UserPromptSubmit', prompt: 'please deploy with aws key ' + FAKE + ' now' };
  const res = await runner.handle(cc(), ev, { home });
  assert.equal(res.decision.decision, 'deny');
  const { file, records } = ledger(home);
  assert.equal(records.length, 1);
  assert.equal(records[0].verdict, 'block');
  assert.match(records[0].rule, /secret$/);
  assert.ok(/secret kinds: \S+/.test(records[0].reason), records[0].reason);
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes(FAKE), 'the secret value is not in the ledger');
  assert.ok(!raw.includes('please deploy'), 'the prompt text is not in the ledger');
  assert.equal(verifyEvidenceLedger(file).valid, true);
});

test('a redaction of tool output is recorded with the kinds only', async () => {
  const home = tmp();
  const ev = { session_id: 's', cwd: home, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 't',
    tool_input: { command: 'cat app.env' }, tool_response: { stdout: 'AWS_ACCESS_KEY_ID=' + FAKE + '\n', stderr: '' } };
  const res = await runner.handle(cc(), ev, { home });
  assert.equal(res.decision.decision, 'allow');
  const { file, records } = ledger(home);
  assert.equal(records.length, 1);
  assert.equal(records[0].rule, 'hook-redacted-output');
  assert.equal(records[0].phase, 'tool-result');
  assert.ok(!fs.readFileSync(file, 'utf8').includes(FAKE));
  assert.ok(!fs.readFileSync(file, 'utf8').includes('app.env'));
  assert.equal(verifyEvidenceLedger(file).valid, true);
});

test('two blocks chain', async () => {
  const home = tmp();
  await runner.handle(cc(), pre(home, 'cat ~/.aws/credentials'), { home });
  await runner.handle(cc(), pre(home, 'cat ~/.ssh/id_rsa'), { home });
  const { file, records } = ledger(home);
  assert.equal(records.length, 2);
  assert.equal(records[1].prev_hash, records[0].record_hash);
  assert.equal(verifyEvidenceLedger(file).valid, true);
});

test('a ledger that cannot be written keeps the deny', async () => {
  const home = tmp();
  // The ledger path is a folder, so the append fails.
  fs.mkdirSync(path.join(home, '.zn', 'evidence.jsonl'), { recursive: true });
  const res = await runner.handle(cc(), pre(home, 'cat ~/.aws/credentials'), { home });
  assert.equal(res.decision.decision, 'deny');
  assert.ok(res.output, 'the deny answer is still produced');
});

test('a damaged ledger keeps the deny and is left as it is', async () => {
  const home = tmp();
  fs.mkdirSync(path.join(home, '.zn'), { recursive: true });
  const file = path.join(home, '.zn', 'evidence.jsonl');
  fs.writeFileSync(file, 'not a ledger line\n');
  const res = await runner.handle(cc(), pre(home, 'cat ~/.aws/credentials'), { home });
  assert.equal(res.decision.decision, 'deny');
  assert.equal(fs.readFileSync(file, 'utf8'), 'not a ledger line\n');
});

test('a busy write lock keeps the deny', async () => {
  const home = tmp();
  fs.mkdirSync(path.join(home, '.zn'), { recursive: true });
  fs.writeFileSync(path.join(home, '.zn', 'evidence.jsonl.lock'), JSON.stringify({ pid: process.pid, token: 'x', t: Date.now() }));
  const res = await runner.handle(cc(), pre(home, 'cat ~/.aws/credentials'), { home });
  assert.equal(res.decision.decision, 'deny');
});
