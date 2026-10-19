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

// Follow-ups (B-365f): an internal error on Stop never exits 2, the transcript is streamed, and Stop reviews have their own counters.

test('an internal error on a Stop event exits 0 with a warning, never 2', async () => {
  const realRespond = codex.respond;
  const realExit = process.exitCode;
  const outBuf = [];
  const errBuf = [];
  const ow = process.stdout.write;
  const ew = process.stderr.write;
  process.stdout.write = (s) => { outBuf.push(String(s)); return true; };
  process.stderr.write = (s) => { errBuf.push(String(s)); return true; };
  codex.respond = () => { throw Object.assign(new Error('boom'), { code: 'EBOOM' }); };
  try {
    process.exitCode = undefined;
    await runner.main(['codex'], async () => JSON.stringify(stop({ last_assistant_message: 'ok' })));
    assert.notEqual(process.exitCode, 2, 'exit 2 would make Codex continue the answer');
    const warn = JSON.parse(outBuf.join(''));
    assert.match(warn.systemMessage, /could not check the last answer for secrets \(EBOOM\)/);
    assert.equal(warn.decision, undefined, 'a warning only, never a block');
    assert.match(errBuf.join(''), /could not check the last answer \(EBOOM\)/);
  } finally {
    codex.respond = realRespond;
    process.stdout.write = ow;
    process.stderr.write = ew;
    process.exitCode = realExit;
  }
});

test('the same internal error on a PreToolUse event still refuses the call (exit 2)', async () => {
  const realRespond = codex.respond;
  const realExit = process.exitCode;
  const ow = process.stdout.write;
  const ew = process.stderr.write;
  process.stdout.write = () => true;
  process.stderr.write = () => true;
  codex.respond = () => { throw Object.assign(new Error('boom'), { code: 'EBOOM' }); };
  try {
    process.exitCode = undefined;
    await runner.main(['codex'], async () => JSON.stringify({
      session_id: 's', turn_id: 't', transcript_path: null, cwd: '/', hook_event_name: 'PreToolUse',
      tool_name: 'Bash', tool_input: { command: 'ls' },
    }));
    assert.equal(process.exitCode, 2);
  } finally {
    codex.respond = realRespond;
    process.stdout.write = ow;
    process.stderr.write = ew;
    process.exitCode = realExit;
  }
});

test('a marker that straddles a read chunk is still seen in the transcript', async (t) => {
  const home = homeWith(t);
  const dir = tempDir(t, 'zn-stop-chunk-');
  const transcript = path.join(dir, 'transcript.jsonl');
  const marker = '__ZN_DB_PASSWORD__';
  const chunk = 256 * 1024;
  const prefix = '{"output":"';
  // The marker starts 9 bytes before the first chunk ends: it is split across two reads.
  const filler = 'x'.repeat(chunk - prefix.length - marker.length / 2);
  fs.writeFileSync(transcript, prefix + filler + marker + '"}\n' + JSON.stringify({ role: 'assistant', text: 'Use ' + marker }) + '\n');
  const r = await run(stop({ last_assistant_message: 'Use ' + marker, transcript_path: transcript }), home);
  assert.equal(r.output, null, 'seen in a tool output, so not flagged');
});

// Codex 0.163.0 writes the final answer to its session log three times (an event
// message, a response item and the task-complete record). These fixtures have
// that shape, with fake values.
function codexLog(parts) {
  const lines = [];
  for (const p of parts.before || []) lines.push(JSON.stringify(p));
  const a = parts.answer;
  for (let i = 0; i < 3; i++) {
    lines.push(JSON.stringify([
      { type: 'event_msg', payload: { type: 'agent_message', message: a } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: a }] } },
      { type: 'event_msg', payload: { type: 'task_complete', last_agent_message: a } },
    ][i]));
  }
  return lines.join('\n') + '\n';
}

test('an unseen placeholder is flagged although Codex wrote the answer three times', async (t) => {
  const home = homeWith(t);
  const dir = tempDir(t, 'zn-stop-x3-');
  const transcript = path.join(dir, 'rollout.jsonl');
  const answer = 'Use the token __ZN_GITHUB_TOKEN__ for the call.\nThen "quote" it.';
  const before = [{ type: 'event_msg', payload: { type: 'user_message', message: 'Use the token for the call.' } }];
  fs.writeFileSync(transcript, codexLog({ before, answer }));
  const r = await run(stop({ last_assistant_message: answer, transcript_path: transcript }), home);
  assert.match(r.output.systemMessage, /did not see earlier in this session \(__ZN_GITHUB_TOKEN__\)/);
  const blocked = await run(stop({ last_assistant_message: answer, transcript_path: transcript }), homeWith(t, { hooks: { stopReview: 'block' } }));
  assert.equal(blocked.output.decision, 'block');
});

test('a placeholder shown by a tool earlier is not flagged with the answer written three times', async (t) => {
  const home = homeWith(t);
  const dir = tempDir(t, 'zn-stop-x3b-');
  const transcript = path.join(dir, 'rollout.jsonl');
  const answer = 'Use the token __ZN_GITHUB_TOKEN__ for the call.';
  const before = [{ type: 'response_item', payload: { type: 'function_call_output', output: 'found __ZN_GITHUB_TOKEN__ in the vault' } }];
  fs.writeFileSync(transcript, codexLog({ before, answer }));
  const r = await run(stop({ last_assistant_message: answer, transcript_path: transcript }), home);
  assert.equal(r.output, null);
});

test('answer copies are counted across a read chunk, and a marker used twice in the answer counts twice per copy', async (t) => {
  const home = homeWith(t);
  const dir = tempDir(t, 'zn-stop-x3c-');
  const transcript = path.join(dir, 'rollout.jsonl');
  const answer = 'Use __ZN_DB_PASSWORD__ and then __ZN_DB_PASSWORD__ again.';
  const filler = JSON.stringify({ type: 'event_msg', payload: { message: 'x'.repeat(256 * 1024 - 120) } }) + '\n';
  fs.writeFileSync(transcript, filler + codexLog({ answer }));
  const r = await run(stop({ last_assistant_message: answer, transcript_path: transcript }), home);
  assert.match(r.output.systemMessage, /\(__ZN_DB_PASSWORD__\)/);
  // One extra use of the marker outside the answer makes it seen.
  fs.writeFileSync(transcript, filler + JSON.stringify({ output: '__ZN_DB_PASSWORD__' }) + '\n' + codexLog({ answer }));
  const seen = await run(stop({ last_assistant_message: answer, transcript_path: transcript }), home);
  assert.equal(seen.output, null);
});

test('with an answer escaped differently in the log, one copy is assumed as before', async (t) => {
  const home = homeWith(t);
  const dir = tempDir(t, 'zn-stop-x1-');
  const transcript = path.join(dir, 'rollout.jsonl');
  const answer = 'Use __ZN_DB_PASSWORD__ é';
  fs.writeFileSync(transcript, JSON.stringify({ text: 'Use __ZN_DB_PASSWORD__ \\u00e9' }) + '\n');
  const r = await run(stop({ last_assistant_message: answer, transcript_path: transcript }), home);
  assert.match(r.output.systemMessage, /\(__ZN_DB_PASSWORD__\)/);
});

test('a final-answer review counts as a stop review, not as a checked tool call', async (t) => {
  const home = homeWith(t);
  const before = process.env.ZN_STATS;
  delete process.env.ZN_STATS; // this test reads the counts, so recording is on here
  try {
    await run(stop({ last_assistant_message: 'The key is ' + AWS }), home);
    await run(stop({ last_assistant_message: 'The tests pass.' }), home);
    const data = JSON.parse(fs.readFileSync(path.join(home, '.zn', 'stats.json'), 'utf8'));
    assert.equal(data.events["stop-review"], 2);
    assert.equal(data.events["stop-review-flagged"], 1);
    assert.equal(Object.values(data.days).some((day) => 'hook:codex' in day), false, 'no tool check counted');
  } finally {
    if (before === undefined) delete process.env.ZN_STATS; else process.env.ZN_STATS = before;
  }
});
