'use strict';

// A failed tool call goes to PostToolUseFailure (Claude Code) / postToolUseFailure (Cursor), not to PostToolUse.
// Those hooks cannot rewrite the error (read 2026-11-17: Claude Code "can't rewrite a result", Cursor only takes
// additional_context), so when the error holds a secret zn adds a warning next to it, and never claims it replaced it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getAdapter } = require('../lib/agents');
const runner = require('../lib/hooks/runner');
const { createFakeVault } = require('./helpers/fake_vault');
const fakeEngine = require('./helpers/fake_engine');
const { generateAll } = require('./fixtures/fake_secrets');

const FAKE = generateAll(5150, { perType: 1, piiPerType: 1 });
const AWS = FAKE.secrets.find((s) => s.type === 'aws_access_key_id').value;

const claude = getAdapter('claude-code');
const cursor = getAdapter('cursor');
const run = (adapter, raw) => runner.handle(adapter, raw, { engine: fakeEngine, vault: createFakeVault(), failMode: 'open' });

const cc = (extra) => ({ session_id: 's', cwd: os.tmpdir(), hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'aws s3 ls' }, tool_use_id: 't', is_interrupt: false, ...extra });
const cu = (extra) => ({ conversation_id: 'c', cwd: os.tmpdir(), hook_event_name: 'postToolUseFailure', tool_name: 'Shell', tool_input: { command: 'aws s3 ls' }, failure_type: 'error', is_interrupt: false, ...extra });

test('Claude Code: a secret in the error of a failed command gets a warning, in the documented shape', async () => {
  const r = await run(claude, cc({ error: 'Exit code 1\nauth failed for key ' + AWS }));
  const o = r.output.hookSpecificOutput;
  assert.equal(o.hookEventName, 'PostToolUseFailure');
  assert.equal(o.updatedToolOutput, undefined, 'a failed result cannot be rewritten');
  assert.match(o.additionalContext, /secret value/);
  assert.match(o.additionalContext, /cannot rewrite/);
  assert.doesNotMatch(JSON.stringify(r.output), new RegExp(AWS), 'the value is never printed back');
  assert.deepEqual(Object.keys(r.output), ['hookSpecificOutput']);
});

test('Claude Code: a clean error, or one without text, gets no answer', async () => {
  assert.equal((await run(claude, cc({ error: 'Exit code 1\nCannot find module express' }))).output, null);
  assert.equal((await run(claude, cc({}))).output, null);
  assert.equal((await run(claude, cc({ error: 'x', tool_name: 'Edit', tool_input: { file_path: '/x' } }))).output, null);
});

test('Claude Code: the normalized event is a post_tool event whose output is the error text', () => {
  const ev = claude.normalize(cc({ error: 'boom' }));
  assert.equal(ev.event, 'post_tool');
  assert.equal(ev.failed, true);
  assert.equal(ev.output, 'boom');
  assert.equal(ev.tool, 'bash');
});

test('Claude Code: an MCP error is checked too', async () => {
  const r = await run(claude, cc({ tool_name: 'mcp__db__query', tool_input: {}, error: 'connection string ' + AWS }));
  assert.match(r.output.hookSpecificOutput.additionalContext, /secret value/);
});

test('Claude Code: a failed call that zn cannot check is never reported as rewritten', () => {
  const ev = claude.normalize(cc({ error: 'x' }));
  const out = claude.respond({ decision: 'allow', updatedOutput: '[withheld]', message: 'zn: replaced', event: ev });
  assert.equal(out.hookSpecificOutput.updatedToolOutput, undefined);
  assert.doesNotMatch(out.hookSpecificOutput.additionalContext, /replaced/);
});

test('Claude Code: the install registers PostToolUseFailure with the same matcher as PostToolUse', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-ptf-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  claude.install({ home, nodePath: '/usr/bin/node', runnerPath: '/x/lib/hooks/runner.js' });
  const data = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
  assert.equal(data.hooks.PostToolUseFailure.length, 1);
  assert.equal(data.hooks.PostToolUseFailure[0].matcher, data.hooks.PostToolUse[0].matcher);
  claude.install({ home, nodePath: '/usr/bin/node', runnerPath: '/x/lib/hooks/runner.js' });
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8')).hooks.PostToolUseFailure.length, 1, 'idempotent');
  claude.uninstall({ home });
  const left = fs.existsSync(path.join(home, '.claude', 'settings.json')) ? JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8')) : {};
  assert.equal((left.hooks || {}).PostToolUseFailure, undefined, 'uninstall removes it');
});

test('Cursor: a secret in the error of a failed shell command or MCP call gets additional_context', async () => {
  for (const extra of [{ error_message: 'denied for ' + AWS }, { tool_name: 'MCP:query', error_message: 'denied for ' + AWS }]) {
    const r = await run(cursor, cu(extra));
    assert.deepEqual(Object.keys(r.output), ['additional_context']);
    assert.match(r.output.additional_context, /secret value/);
    assert.doesNotMatch(JSON.stringify(r.output), new RegExp(AWS));
  }
});

test('Cursor: a clean error, or one without text, gets no answer (not a permission hook, so empty output is valid)', async () => {
  assert.equal((await run(cursor, cu({ error_message: 'command not found' }))).output, null);
  assert.equal((await run(cursor, cu({}))).output, null);
});

test('Cursor: the install registers postToolUseFailure, without failClosed', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-ptf-cu-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  cursor.install({ home, nodePath: '/usr/bin/node', runnerPath: '/x/lib/hooks/runner.js' });
  const data = JSON.parse(fs.readFileSync(cursor.hooksFile({ home }), 'utf8'));
  assert.equal(data.hooks.postToolUseFailure.length, 1);
  assert.equal(data.hooks.postToolUseFailure[0].failClosed, undefined);
  cursor.uninstall({ home });
});
