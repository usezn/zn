'use strict';

// Fuzz test for the hook entry point (lib/hooks/runner.js): whatever an agent
// puts on stdin, the hook ends with an answer and never lets garbage through.
//
//   1. Text that is not a JSON object (random text, empty, truncated, huge,
//      deeply nested) is refused with exit code 2, except a broken Stop event,
//      which is documented to pass with a warning.
//   2. Any JSON object, in the shapes of every supported agent but with wrong
//      types in every field, ends cleanly: exit code 0 or 2, stdout empty or
//      valid JSON, no stack trace, and never exit code 2 for a Stop event.
//   3. A read of a protected file is denied however much junk surrounds it.
//   4. The same holds for raw bytes (invalid UTF-8) through a real process.
//
// Cases are generated with fast-check. Normal runs are short (60 cases per
// property). The weekly job raises them:
//   ZN_FUZZ_RUNS=5000 ZN_FUZZ_SECONDS=240 node --test test/hooks_fuzz.test.js
// A failure prints the seed; replay with ZN_FUZZ_SEED=<seed>.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// The hook writes counters and looks for config under the home folder: use a throwaway one.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-hookfuzz-'));
fs.mkdirSync(path.join(HOME, '.zn'), { recursive: true });
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.ZN_HOOK_FAIL_MODE = '';
after(() => fs.rmSync(HOME, { recursive: true, force: true }));

const RUNNER = path.resolve(__dirname, '..', 'lib', 'hooks', 'runner.js');
const runner = require('../lib/hooks/runner');

const RUNS = Number(process.env.ZN_FUZZ_RUNS) || 60;
const SECONDS = Number(process.env.ZN_FUZZ_SECONDS) || 0;
const PARAMS = {
  numRuns: RUNS,
  ...(SECONDS ? { interruptAfterTimeLimit: SECONDS * 1000 } : {}),
  ...(process.env.ZN_FUZZ_SEED ? { seed: Number(process.env.ZN_FUZZ_SEED) } : {}),
};
// Each property gets an even share of the time budget.
const PROPS = 4;
const share = (p) => (SECONDS ? { ...p, interruptAfterTimeLimit: Math.max(1000, Math.floor((SECONDS * 1000) / PROPS)) } : p);

const AGENTS = ['claude-code', 'codex', 'cursor', 'opencode', 'antigravity'];

/* ------------------------------ harness ------------------------------ */

// Runs the hook in this process with stdin replaced by `text`; returns what it wrote and its exit code.
async function run(agent, text) {
  if (process.platform === 'win32') fs.writeSync(2, 'FUZZCASE ' + agent + ' ' + JSON.stringify(text).slice(0, 3000) + '\n'); // TEMP
  const out = [];
  const err = [];
  const write = { out: process.stdout.write, err: process.stderr.write };
  process.exitCode = undefined;
  process.stdout.write = (c) => { out.push(String(c)); return true; };
  process.stderr.write = (c) => { err.push(String(c)); return true; };
  let thrown = null;
  try {
    await runner.main([agent], async () => text);
  } catch (e) {
    thrown = e;
  } finally {
    process.stdout.write = write.out;
    process.stderr.write = write.err;
  }
  const code = process.exitCode === undefined ? 0 : process.exitCode;
  process.exitCode = undefined;
  return { code, stdout: out.join(''), stderr: err.join(''), thrown };
}

const STOP_RE = /"hook_event_name"\s*:\s*"Stop"/;

// What the runner must do with text that is not a JSON object.
function expectRefused(agent, text) {
  const r = text.replace(/^﻿/, '');
  if (!r.trim()) return true;
  let parsed;
  try { parsed = JSON.parse(r); } catch (_) { return !STOP_RE.test(r); }
  return parsed === null || typeof parsed !== 'object' || Array.isArray(parsed);
}

function assertClean(res, ctx) {
  assert.equal(res.thrown, null, ctx + ': the hook threw ' + res.thrown);
  assert.ok(res.code === 0 || res.code === 2, ctx + ': exit code ' + res.code);
  if (res.stdout) {
    assert.doesNotThrow(() => JSON.parse(res.stdout), ctx + ': stdout is not JSON');
  }
  assert.ok(!/\n\s+at .*\(.*:\d+:\d+\)/.test(res.stderr), ctx + ': a stack trace reached stderr');
}

function isBlock(res) {
  if (res.code === 2) return true;
  if (!res.stdout) return false;
  let o;
  try { o = JSON.parse(res.stdout); } catch (_) { return false; }
  const hso = o && o.hookSpecificOutput;
  return Boolean((hso && hso.permissionDecision === 'deny') || o.permission === 'deny' || o.decision === 'deny' || o.decision === 'block');
}

/* ---------------------------- generators ----------------------------- */

const weird = fc.oneof(
  fc.jsonValue({ maxDepth: 4 }),
  fc.string({ unit: 'binary', maxLength: 80 }),
  fc.constantFrom(null, true, false, 0, -1, 1e308, '', ' ', [], {}, [[]], { a: { b: [null] } }),
  fc.string({ maxLength: 200 }),
);

const NAMES = [
  'PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'UserPromptExpansion', 'Stop', 'PermissionRequest',
  'beforeReadFile', 'beforeShellExecution', 'beforeSubmitPrompt', 'beforeMCPExecution', 'preToolUse', 'postToolUse',
  'tool.execute.before', 'tool.execute.after', 'chat.message',
];
const TOOLS = [
  'Bash', 'PowerShell', 'Monitor', 'Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Grep', 'Glob', 'LSP', 'WebFetch',
  'mcp__srv__tool', 'mcp__secrets__secrets_http_request', 'apply_patch', 'patch', 'read_mcp_resource', 'view_file', 'run_command', '',
];
const name = fc.oneof({ weight: 4, arbitrary: fc.constantFrom(...NAMES) }, { weight: 1, arbitrary: weird });
const tool = fc.oneof({ weight: 4, arbitrary: fc.constantFrom(...TOOLS) }, { weight: 1, arbitrary: weird });

// An object whose keys are the ones the agents read, each with a value of any type.
const KEYS = [
  'hook_event_name', 'hookEventName', 'hook', 'tool_name', 'tool', 'tool_input', 'tool_response', 'tool_output', 'toolCall', 'args',
  'prompt', 'command', 'file_path', 'path', 'url', 'content', 'output', 'metadata', 'cwd', 'session_id', 'sessionID',
  'conversation_id', 'conversationId', 'workspace_roots', 'workspacePaths', 'transcript_path', 'last_assistant_message',
  'stop_hook_active', 'mcp_server_name', 'expansion_type', 'command_name', 'command_args',
];
const inner = fc.dictionary(fc.constantFrom('command', 'file_path', 'path', 'filePath', 'url', 'content', 'old_string', 'new_string',
  'new_source', 'edits', 'workdir', 'patchText', 'name', 'args', 'Cwd', 'CommandLine', 'AbsolutePath', 'paths'), weird, { maxKeys: 6 });
const eventObject = fc.record({
  hook_event_name: name, hook: name, tool_name: tool, tool: tool,
  tool_input: fc.oneof(inner, weird), tool_response: weird, tool_output: weird, args: fc.oneof(inner, weird),
  toolCall: fc.oneof(fc.record({ name: tool, args: fc.oneof(inner, weird) }, { requiredKeys: [] }), weird),
  prompt: weird, command: weird, file_path: weird, cwd: weird, output: weird, metadata: weird, content: weird,
  session_id: weird, last_assistant_message: weird, transcript_path: weird, stop_hook_active: weird,
}, { requiredKeys: [] });
const keySoup = fc.dictionary(fc.oneof(fc.constantFrom(...KEYS), fc.string({ maxLength: 12 })), weird, { maxKeys: 10 });
const anyEvent = fc.oneof(eventObject, keySoup);

// Text that is not an event: noise, truncations of real events, huge and deeply nested documents.
const REAL = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo hello' }, cwd: '/work/example', session_id: 's1' });
const text = fc.oneof(
  { weight: 3, arbitrary: fc.string({ unit: 'binary', maxLength: 300 }) },
  { weight: 2, arbitrary: fc.string({ maxLength: 300 }) },
  { weight: 3, arbitrary: fc.nat(REAL.length).map((n) => REAL.slice(0, n)) },
  { weight: 1, arbitrary: fc.constantFrom('', ' ', '\n', '﻿', 'null', 'true', '0', '"x"', '[]', '[{}]', '{', '}', '{"a":', '﻿{') },
  { weight: 1, arbitrary: fc.integer({ min: 1, max: 60000 }).map((n) => '['.repeat(n)) },
  { weight: 1, arbitrary: fc.integer({ min: 1, max: 3000 }).map((n) => '['.repeat(n) + ']'.repeat(n)) },
  { weight: 1, arbitrary: fc.integer({ min: 1, max: 3000 }).map((n) => '{"a":'.repeat(n) + '1' + '}'.repeat(n)) },
  { weight: 1, arbitrary: fc.integer({ min: 1, max: 4 }).map((mb) => '{"prompt":"' + 'a'.repeat(mb * 250000) + '"}') },
  { weight: 1, arbitrary: fc.integer({ min: 1, max: 4 }).map((mb) => '{"hook_event_name":"Stop","last_assistant_message":"' + 'x'.repeat(mb * 100000)) },
);

/* ------------------------------ properties --------------------------- */

test('text that is not a JSON object is refused (every agent)', async () => {
  await fc.assert(fc.asyncProperty(fc.constantFrom(...AGENTS), text, async (agent, t) => {
    const res = await run(agent, t);
    assertClean(res, agent);
    if (expectRefused(agent, t)) assert.equal(res.code, 2, agent + ': garbage was not refused');
  }), share(PARAMS));
});

test('any JSON object ends cleanly, and a Stop event is never exit code 2', async () => {
  await fc.assert(fc.asyncProperty(fc.constantFrom(...AGENTS), anyEvent, async (agent, ev) => {
    const res = await run(agent, JSON.stringify(ev));
    assertClean(res, agent);
    if (ev.hook_event_name === 'Stop') assert.notEqual(res.code, 2, agent + ': a Stop event must not exit 2');
  }), share(PARAMS));
});

test('a read of a protected file is denied whatever surrounds it', async () => {
  const protectedFile = path.join(HOME, '.zn', 'config.json');
  const extra = fc.dictionary(fc.constantFrom('session_id', 'cwd', 'permission_mode', 'transcript_path', 'tool_use_id', 'x'), weird, { maxKeys: 5 });
  await fc.assert(fc.asyncProperty(extra, async (junk) => {
    const ev = { ...junk, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: protectedFile } };
    const res = await run('claude-code', JSON.stringify(ev));
    assertClean(res, 'claude-code Read');
    assert.ok(isBlock(res), 'a protected file was not blocked: ' + JSON.stringify(res));
  }), share(PARAMS));
});

test('raw bytes through a real process end with a refusal or valid JSON', () => {
  const runs = Math.max(5, Math.min(RUNS, SECONDS ? 200 : 15));
  const bytes = fc.oneof(
    fc.uint8Array({ maxLength: 400 }),
    fc.nat(REAL.length).map((n) => Buffer.from(REAL).subarray(0, n)),
    fc.nat(REAL.length).chain((n) => fc.uint8Array({ minLength: 1, maxLength: 4 }).map((b) => Buffer.concat([Buffer.from(REAL).subarray(0, n), Buffer.from(b)]))),
  );
  fc.assert(fc.property(fc.constantFrom(...AGENTS), bytes, (agent, buf) => {
    if (process.platform === 'win32') fs.writeSync(2, 'FUZZBYTES ' + agent + ' ' + Buffer.from(buf).toString('hex').slice(0, 3000) + '\n'); // TEMP
    const res = spawnSync(process.execPath, [RUNNER, agent], {
      input: Buffer.from(buf),
      encoding: 'utf8',
      timeout: 20000,
      env: { ...process.env, HOME, USERPROFILE: HOME, ZN_HOOK_FAIL_MODE: '' },
    });
    assert.equal(res.error, undefined, 'the hook did not finish: ' + (res.error && res.error.message));
    assert.ok(res.status === 0 || res.status === 2, agent + ': exit code ' + res.status);
    assert.ok(!/\n\s+at .*\(.*:\d+:\d+\)/.test(res.stderr), agent + ': a stack trace reached stderr');
    if (res.stdout) JSON.parse(res.stdout);
    const t = Buffer.from(buf).toString('utf8');
    if (expectRefused(agent, t)) assert.equal(res.status, 2, agent + ': garbage was not refused');
  }), { ...PARAMS, numRuns: runs, ...(SECONDS ? { interruptAfterTimeLimit: Math.floor((SECONDS * 1000) / PROPS) } : {}) });
});
