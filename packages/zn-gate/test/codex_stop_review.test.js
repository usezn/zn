'use strict';

// zn-gate stats: these tests must never count into the real ~/.zn/stats.json.
process.env.ZN_STATS = 'off';

// Codex Stop hook: zn reviews the final answer for a secret value or a __ZN_
// placeholder that did not come from a tool. Warns by default; blocks only with
// hooks.stopReview "block", and never when stop_hook_active is true. Values are fake.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { getAdapter } = require('../lib/agents');
const runner = require('../lib/hooks/runner');
const { createFakeVault } = require('./helpers/fake_vault');
const fakeEngine = require('./helpers/fake_engine');
const { generateAll } = require('./fixtures/fake_secrets');
const { tempDir } = require('./helpers/tmp');

const FAKE = generateAll(5150, { perType: 1, piiPerType: 1 });
const AWS = FAKE.secrets.find((s) => s.type === 'aws_access_key_id').value;

const codex = getAdapter('codex');

const stop = (extra) => ({
  session_id: 's',
  turn_id: 't',
  transcript_path: null,
  cwd: '/',
  hook_event_name: 'Stop',
  model: 'm',
  permission_mode: 'default',
  last_assistant_message: '',
  stop_hook_active: false,
  ...extra,
});

// A home with an optional ~/.zn/config.json, so the setting is read from disk as in production.
function homeWith(t, config) {
  const home = tempDir(t, 'zn-stop-');
  if (config) {
    fs.mkdirSync(path.join(home, '.zn'), { recursive: true });
    fs.writeFileSync(path.join(home, '.zn', 'config.json'), JSON.stringify(config));
  }
  return home;
}

function run(raw, home, extra = {}) {
  return runner.handle(codex, raw, { engine: fakeEngine, vault: createFakeVault(), failMode: 'open', home, ...extra });
}

test('a clean final answer gives no output', async (t) => {
  const r = await run(stop({ last_assistant_message: 'The tests pass. Nothing to see here.' }), homeWith(t));
  assert.equal(r.output, null);
});

test('a secret in the final answer warns by default and never blocks', async (t) => {
  const r = await run(stop({ last_assistant_message: 'The key is ' + AWS + ', use it carefully.' }), homeWith(t));
  assert.equal(r.output.decision, undefined, 'no block field');
  assert.match(r.output.systemMessage, /^zn: the last answer contains a secret value/);
  assert.match(r.output.systemMessage, /stopReview/, 'says how to turn blocking on');
  assert.ok(!JSON.stringify(r.output).includes(AWS), 'the value is never shown');
});

test('opt-in block: a secret in the final answer blocks with a reason for the model', async (t) => {
  const home = homeWith(t, { hooks: { stopReview: 'block' } });
  const r = await run(stop({ last_assistant_message: 'The key is ' + AWS }), home);
  assert.equal(r.output.decision, 'block');
  assert.match(r.output.reason, /Rewrite it without that value or placeholder/);
  assert.match(r.output.reason, /a secret value \(/);
  assert.ok(!JSON.stringify(r.output).includes(AWS), 'the reason never repeats the value');
});

test('stop_hook_active true never blocks, even with the opt-in on', async (t) => {
  const home = homeWith(t, { hooks: { stopReview: 'block' } });
  const r = await run(stop({ last_assistant_message: 'Again ' + AWS, stop_hook_active: true }), home);
  assert.equal(r.output.decision, undefined);
  assert.match(r.output.systemMessage, /does not block a second time/);
});

test('an unknown stopReview value keeps the default: warn only', async (t) => {
  const home = homeWith(t, { hooks: { stopReview: 'yes please' } });
  const r = await run(stop({ last_assistant_message: 'Again ' + AWS }), home);
  assert.equal(r.output.decision, undefined);
  assert.ok(r.output.systemMessage);
});

test('a placeholder the session never showed is flagged; one seen in a tool output is not', async (t) => {
  const home = homeWith(t);
  const dir = tempDir(t, 'zn-stop-tr-');
  const transcript = path.join(dir, 'transcript.jsonl');
  const answer = 'Use __ZN_DB_PASSWORD__ for the database.';

  // Only the final answer contains the marker: it did not come from a tool.
  fs.writeFileSync(transcript, JSON.stringify({ role: 'assistant', text: answer }) + '\n');
  const flagged = await run(stop({ last_assistant_message: answer, transcript_path: transcript }), home);
  assert.match(flagged.output.systemMessage, /did not see earlier in this session \(__ZN_DB_PASSWORD__\)/);

  // The same marker came from a tool output earlier in the session: not flagged.
  fs.writeFileSync(transcript, [
    JSON.stringify({ role: 'tool', output: 'config: __ZN_DB_PASSWORD__' }),
    JSON.stringify({ role: 'assistant', text: answer }),
  ].join('\n') + '\n');
  const seen = await run(stop({ last_assistant_message: answer, transcript_path: transcript }), home);
  assert.equal(seen.output, null);

  // Opt-in block applies to the placeholder case too.
  const blocking = homeWith(t, { hooks: { stopReview: 'block' } });
  fs.writeFileSync(transcript, JSON.stringify({ role: 'assistant', text: answer }) + '\n');
  const blocked = await run(stop({ last_assistant_message: answer, transcript_path: transcript }), blocking);
  assert.equal(blocked.output.decision, 'block');
  assert.match(blocked.output.reason, /placeholder zn did not see/);
});

test('a placeholder is not flagged when the transcript cannot be read', async (t) => {
  const r = await run(stop({ last_assistant_message: 'Use __ZN_DB_PASSWORD__ here.', transcript_path: '/no/such/file.jsonl' }), homeWith(t));
  assert.equal(r.output, null);
});

test('an engine failure never blocks the answer; it warns', async (t) => {
  const broken = {
    scan() { throw Object.assign(new Error('engine down'), { code: 'ZN_ENGINE' }); },
    prepare: async (ctx) => ctx,
  };
  const home = homeWith(t, { hooks: { stopReview: 'block' } });
  const r = await run(stop({ last_assistant_message: 'A long enough answer text.' }), home, { engine: broken });
  assert.equal(r.output.decision, undefined);
  assert.match(r.output.systemMessage, /could not check the last answer for secrets \(ZN_ENGINE\)/);
});

test('an unreadable Stop event on stdin is passed, not blocked (exit 0, no output)', () => {
  const script = path.resolve(__dirname, '..', 'lib', 'hooks', 'runner.js');
  const res = spawnSync(process.execPath, [script, 'codex'], {
    input: '{"hook_event_name":"Stop","last_assistant_message":' + '\n',
    encoding: 'utf8',
  });
  assert.equal(res.status, 0);
  assert.equal(res.stdout, '');
  assert.match(res.stderr, /could not read this Stop event/);
});

test('install adds one Stop group, keeps the user hooks, is idempotent, and uninstall removes it', (t) => {
  const home = tempDir(t, 'zn-stop-cx-');
  const env = { CODEX_HOME: path.join(home, '.codex') };
  const file = codex.hooksFile({ env });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'mine.sh' }] }] } }));
  const opts = { env, nodePath: '/usr/bin/node', runnerPath: '/x/lib/hooks/runner.js' };

  codex.install(opts);
  codex.install(opts);
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(data.hooks.Stop.length, 2, 'the user hook and one zn group');
  assert.equal(data.hooks.Stop[0].hooks[0].command, 'mine.sh', 'user hook kept');
  assert.equal(data.hooks.Stop[1].matcher, undefined, 'Stop has no matcher');
  assert.equal(data.hooks.Stop[1].hooks[0].command, "'/usr/bin/node' '/x/lib/hooks/runner.js' codex");

  codex.uninstall({ env });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).hooks, {
    Stop: [{ hooks: [{ type: 'command', command: 'mine.sh' }] }],
  });
});
