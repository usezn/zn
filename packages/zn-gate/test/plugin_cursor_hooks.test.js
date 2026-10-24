'use strict';

// The Cursor plugin and `zn hooks install cursor` must agree on which hooks fail closed, and a hook may only
// fail closed when zn always writes an answer on that event. Cursor's documentation (cursor.com/docs/agent/hooks)
// says failClosed blocks the action on "no output", and its permission hooks accept no neutral answer: "allow"
// would skip Cursor's own approval, and an empty object is not a valid permission answer. So an event where zn
// has no objection and stays silent must not be failClosed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { getAdapter } = require('../lib/agents');

const cursor = getAdapter('cursor');
const hooksFile = path.join(__dirname, '..', '..', '..', 'plugins', 'zn-gate', 'cursor', 'hooks.json');
const plugin = () => JSON.parse(fs.readFileSync(hooksFile, 'utf8')).hooks;

// One ordinary, harmless call for each event, and the decision zn reaches for it: no objection.
const RAW = {
  beforeReadFile: { file_path: '/work/src/index.js' },
  beforeShellExecution: { command: 'echo hello', cwd: '/work' },
  beforeSubmitPrompt: { prompt: 'rename this function' },
  beforeMCPExecution: { tool_name: 'query', mcp_server_name: 'db', tool_input: '{"sql":"select 1"}' },
  preToolUse: { tool_name: 'Write', tool_input: { file_path: '/work/src/a.js' } },
  postToolUse: { tool_name: 'Shell', tool_input: { command: 'echo hello' }, tool_output: '{"exitCode":0,"stdout":"hello"}' },
};
const answer = (event) => {
  const ev = cursor.normalize({ conversation_id: 'c', generation_id: 'g', workspace_roots: ['/work'], cwd: '/work', hook_event_name: event, ...RAW[event] });
  return cursor.respond({ decision: 'allow', event: ev });
};

test('the plugin only hooks events the CLI install knows', () => {
  for (const event of Object.keys(plugin())) assert.ok(cursor.EVENTS.includes(event), event);
});

test('the plugin sets failClosed on the same events as the CLI install', () => {
  const closed = Object.entries(plugin()).filter(([, list]) => list.some((h) => h.failClosed === true)).map(([e]) => e).sort();
  const installed = Object.entries(cursor.hookEntries('zn hook cursor')).filter(([, h]) => h.failClosed === true).map(([e]) => e).sort();
  assert.deepEqual(closed, installed);
  assert.deepEqual(closed, ['beforeReadFile', 'beforeSubmitPrompt']);
});

test('every failClosed event gets an explicit answer when zn has no objection', () => {
  for (const [event, list] of Object.entries(plugin())) {
    if (!list.some((h) => h.failClosed === true)) continue;
    const a = answer(event);
    assert.ok(a && typeof a === 'object', event + ' is failClosed but zn would write no output');
    assert.ok(a.permission === 'allow' || a.continue === true, event + ': ' + JSON.stringify(a));
  }
});

test('an event where zn stays silent is not failClosed (it would block every ordinary call)', () => {
  for (const event of ['beforeShellExecution', 'beforeMCPExecution', 'preToolUse', 'postToolUse']) {
    assert.equal(answer(event), null, event);
    for (const h of plugin()[event] || []) assert.notEqual(h.failClosed, true, event);
  }
});

test('zn never answers "allow" on shell, MCP or tool-use events (that could skip Cursor\'s own approval)', () => {
  for (const event of ['beforeShellExecution', 'beforeMCPExecution', 'preToolUse']) {
    const a = answer(event);
    assert.ok(a === null || a.permission !== 'allow', event);
  }
});

test('a deny is still written on every event that can deny', () => {
  for (const event of ['beforeReadFile', 'beforeShellExecution', 'beforeMCPExecution', 'preToolUse']) {
    const ev = cursor.normalize({ conversation_id: 'c', generation_id: 'g', workspace_roots: ['/work'], cwd: '/work', hook_event_name: event, ...RAW[event] });
    const a = cursor.respond({ decision: 'deny', message: 'no', event: ev });
    assert.equal(a.permission, 'deny', event);
  }
  const ev = cursor.normalize({ conversation_id: 'c', generation_id: 'g', hook_event_name: 'beforeSubmitPrompt', ...RAW.beforeSubmitPrompt });
  assert.equal(cursor.respond({ decision: 'deny', message: 'no', event: ev }).continue, false);
});

/* Cursor's handling of a hook answer, as its documentation describes it (cursor.com/docs/agent/hooks):
 * exit code 2 blocks; with failClosed, a crash, a timeout, a non-zero exit code or no output blocks; a
 * permission hook whose answer is not valid JSON, or has no valid decision, blocks even without failClosed. */
function cursorBlocks(entry, event, res) {
  if (res.status === 2) return true;
  const out = String(res.stdout || '').trim();
  if (entry.failClosed === true && (res.status !== 0 || out === '')) return true;
  if (res.status !== 0 || out === '') return false; // fails open
  let a;
  try { a = JSON.parse(out); } catch (_) { return ['beforeShellExecution', 'beforeMCPExecution', 'beforeReadFile', 'preToolUse'].includes(event); }
  if (a.permission === 'deny' || a.continue === false) return true;
  return false;
}

test('the simulation: a failClosed hook that writes nothing blocks, a silent hook without failClosed does not', () => {
  assert.equal(cursorBlocks({ failClosed: true }, 'beforeShellExecution', { status: 0, stdout: '' }), true);
  assert.equal(cursorBlocks({}, 'beforeShellExecution', { status: 0, stdout: '' }), false);
  assert.equal(cursorBlocks({ failClosed: true }, 'beforeReadFile', { status: 0, stdout: '{"permission":"allow"}' }), false);
});

test('with the real hook on an ordinary call, no event of the plugin is blocked', (t) => {
  const { spawnSync } = require('child_process');
  const os = require('os');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-cu-plugin-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const proj = path.join(home, 'proj');
  fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
  const runner = path.resolve(__dirname, '..', 'lib', 'hooks', 'runner.js');
  const raw = {
    beforeReadFile: { file_path: path.join(proj, 'src', 'index.js'), content: 'x' },
    beforeShellExecution: { command: 'echo hello', cwd: proj },
    beforeSubmitPrompt: { prompt: 'rename this function' },
    preToolUse: { tool_name: 'Write', tool_input: { file_path: path.join(proj, 'src', 'a.js'), content: 'x' } },
    postToolUse: { tool_name: 'Shell', tool_input: { command: 'echo hello' }, tool_output: '{"exitCode":0,"stdout":"hello"}' },
  };
  for (const [event, list] of Object.entries(plugin())) {
    assert.ok(raw[event], 'no sample call for ' + event + ': add one');
    const ev = { conversation_id: 'c', generation_id: 'g', workspace_roots: [proj], cwd: proj, hook_event_name: event, ...raw[event] };
    const res = spawnSync(process.execPath, [runner, 'cursor'], { input: JSON.stringify(ev), env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8' });
    for (const entry of list) assert.equal(cursorBlocks(entry, event, res), false, event + ': ' + JSON.stringify({ status: res.status, stdout: res.stdout, stderr: res.stderr }));
  }
});
