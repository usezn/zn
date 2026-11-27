'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const messages = require('../lib/messages');
const runner = require('../lib/hooks/runner');
const { getAdapter } = require('../lib/agents');

function nested(levels) { return JSON.parse('{"a":'.repeat(levels) + '1' + '}'.repeat(levels)); }
const NEXT = /Next step: ask the agent to send/;

test('the unreadable-file-address text gives the cause and one next step, without the format-change advice', () => {
  assert.match(messages.UNREADABLE_FILE_ADDRESS, /^zn: could not read a file address in this call/);
  assert.match(messages.UNREADABLE_FILE_ADDRESS, NEXT);
  assert.match(messages.UNREADABLE_FILE_ADDRESS, /nested deeper than 6 levels/);
});

test('an MCP call with arguments nested too deep is blocked with a flatter-call next step', async () => {
  const ev = { hook_event_name: 'PreToolUse', tool_name: 'mcp__files__write', tool_input: { a: nested(8), path: 'x.txt' }, cwd: '/' };
  const res = await runner.handle(getAdapter('claude-code'), ev, {});
  assert.equal(res.decision.decision, 'deny');
  assert.match(res.decision.message, /nested deeper than 6 levels/);
  assert.match(res.decision.message, NEXT);
});

test('Gemini CLI: an unreadable file address in an MCP call is blocked with that next step and not the update advice', async () => {
  const ev = { hook_event_name: 'BeforeTool', tool_name: 'mcp_files_write', tool_input: { a: nested(9) }, cwd: '/', session_id: 's', timestamp: 't' };
  const res = await runner.handle(getAdapter('gemini'), ev, {});
  const text = JSON.stringify(res.output || res.decision);
  assert.match(text, /could not read a file address/);
  assert.match(text, NEXT);
  assert.doesNotMatch(text, /changed the format/);
});

test('an event nested too deeply to read says what to ask the agent', async () => {
  const ev = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls', extra: nested(10000) }, cwd: '/' };
  const res = await runner.handle(getAdapter('claude-code'), ev, {});
  assert.equal(res.decision.decision, 'deny');
  assert.match(res.decision.message, /nested too deeply/);
  assert.match(res.decision.message, NEXT);
});
