'use strict';

process.env.ZN_STATS = 'off';

// Events captured from a real Gemini CLI (version in fixtures/gemini/VERSION) running against a scripted model on
// localhost, with every identifier replaced. They check that the adapter reads the REAL BeforeTool shape and that
// AfterTool is still not mistaken for a BeforeTool. Unlike fixtures/gemini-cli, nothing here was written from the docs.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { getAdapter } = require('../lib/agents');
const runner = require('../lib/hooks/runner');
const { createFakeVault } = require('./helpers/fake_vault');
const fakeEngine = require('./helpers/fake_engine');

const gem = getAdapter('gemini');
const DIR = path.join(__dirname, 'fixtures', 'gemini');
const load = (n) => JSON.parse(fs.readFileSync(path.join(DIR, n + '.json'), 'utf8'));
const run = (raw) => runner.handle(gem, raw, { engine: fakeEngine, vault: createFakeVault(), failMode: 'open', znRunPrefix: 'ZN_AGENT=x "node" "run.js" --' });

test('the fixtures name the Gemini CLI version they came from', () => {
  assert.match(fs.readFileSync(path.join(DIR, 'VERSION'), 'utf8').trim(), /^\d+\.\d+\.\d+$/);
});

test('real BeforeTool shape: only the documented base fields, no mcp_context, a .jsonl transcript', () => {
  for (const n of ['before_tool_shell', 'before_tool_read_file']) {
    const e = load(n);
    assert.deepEqual(Object.keys(e).sort(), ['cwd', 'hook_event_name', 'session_id', 'timestamp', 'tool_input', 'tool_name', 'transcript_path']);
    assert.equal(e.hook_event_name, 'BeforeTool');
    assert.match(e.transcript_path, /\.jsonl$/);
  }
});

test('real AfterTool shape: tool_response is an object whose llmContent and returnDisplay are strings', () => {
  for (const n of ['after_tool_shell', 'after_tool_read_file']) {
    const e = load(n);
    assert.equal(e.hook_event_name, 'AfterTool');
    assert.deepEqual(Object.keys(e.tool_response).sort(), ['llmContent', 'returnDisplay']);
    assert.equal(typeof e.tool_response.llmContent, 'string');
    assert.equal(typeof e.tool_response.returnDisplay, 'string');
    assert.ok(isNaN(Date.parse(e.timestamp)) === false);
  }
  // The shell output reaches the model inside an untrusted_context wrapper; a file read is the raw text.
  assert.match(load('after_tool_shell').tool_response.llmContent, /^<untrusted_context>\nOutput: zn-test-marker\n/);
  assert.equal(load('after_tool_read_file').tool_response.llmContent, 'fake file content: EXAMPLE_KEY=fake-value-0000\n');
  // returnDisplay is the UI text and can be empty while llmContent holds the data.
  assert.equal(load('after_tool_read_file').tool_response.returnDisplay, '');
});

test('adapter reads the real shell BeforeTool event', () => {
  const ev = gem.normalize(load('before_tool_shell'));
  assert.equal(ev.event, 'pre_tool');
  assert.equal(ev.tool, 'bash');
  assert.equal(ev.input.command, 'echo zn-test-marker');
  assert.equal(ev.cwd, '/work/proj');
  assert.equal(ev.unreadable, undefined);
});

test('adapter reads the real read_file BeforeTool event', () => {
  const ev = gem.normalize(load('before_tool_read_file'));
  assert.equal(ev.event, 'pre_tool');
  assert.equal(ev.tool, 'read');
  assert.deepEqual(ev.input.paths, ['/work/proj/notes.txt']);
  assert.equal(ev.unreadable, undefined);
});

test('a harmless real BeforeTool gives no output', async () => {
  for (const n of ['before_tool_shell', 'before_tool_read_file']) {
    const r = await run(load(n));
    assert.equal(r.output, null, n);
  }
});

test('a real AfterTool event is not read as a BeforeTool: no event, no output', async () => {
  for (const n of ['after_tool_shell', 'after_tool_read_file']) {
    assert.equal(gem.normalize(load(n)).event, null, n);
    const r = await run(load(n));
    assert.equal(r.output, null, n);
  }
});

test('a real BeforeTool shape with a different command is still read from tool_input.command', () => {
  const e = load('before_tool_shell');
  e.tool_input = { command: 'cat .env' };
  const ev = gem.normalize(e);
  assert.equal(ev.tool, 'bash');
  assert.equal(ev.input.command, 'cat .env');
});

test('model_side.json records what the model got for allow, AfterTool deny and AfterTool exit 2', () => {
  const m = load('model_side');
  assert.deepEqual(Object.keys(m.allow_shell), ['output']);
  assert.deepEqual(Object.keys(m.afterTool_deny_json.function_response), ['error']);
  assert.deepEqual(Object.keys(m.afterTool_exit2.function_response), ['error']);
});
