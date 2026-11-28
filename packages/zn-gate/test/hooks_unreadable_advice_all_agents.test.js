'use strict';
process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const runner = require('../lib/hooks/runner');
const { getAdapter } = require('../lib/agents');

function nested(levels) { return JSON.parse('{"a":'.repeat(levels) + '1' + '}'.repeat(levels)); }
const FLATTER = /Next step: ask the agent to send/;
const LIMITS = /nested deeper than 6 levels/;

async function blockedText(agent, raw) {
  const res = await runner.handle(getAdapter(agent), raw, {});
  return JSON.stringify(res.output || res.decision);
}
function assertAdvice(text, cause) {
  assert.match(text, cause);
  assert.match(text, FLATTER);
  assert.match(text, LIMITS);
  assert.doesNotMatch(text, /changed the format|update zn-gate/);
}

test('Copilot CLI: an unreadable file address and arguments nested too deeply both give the cause, the limits and the flatter-call step', async () => {
  const pre = (toolName, toolArgs) => ({ sessionId: 's1', timestamp: 1792400000000, cwd: '/work/proj', toolName, toolArgs });
  assertAdvice(await blockedText('copilot', pre('view', { a: nested(9) })), /could not read a file address/);
  assertAdvice(await blockedText('copilot', pre('some_new_tool', { a: nested(9) })), /could not read the arguments of this call/);
});

test('ZCode: an unreadable file address and arguments nested too deeply both give the cause, the limits and the flatter-call step', async () => {
  const pre = (tool_name, tool_input) => ({ hook_event_name: 'PreToolUse', session_id: 's', cwd: '/work/proj', tool_name, tool_input });
  assertAdvice(await blockedText('zcode', pre('mcp__files__write', { a: nested(9) })), /could not read a file address/);
  assertAdvice(await blockedText('zcode', pre('some_new_tool', { a: nested(9) })), /could not read the arguments of this call/);
});

test('Gemini CLI: an unreadable file address and an action nested too deeply both give the cause and the flatter-call step', async () => {
  const pre = (tool_name, tool_input) => ({ hook_event_name: 'BeforeTool', session_id: 's', timestamp: 't', cwd: '/work/proj', tool_name, tool_input });
  assertAdvice(await blockedText('gemini', pre('mcp_files_write', { a: nested(9) })), /could not read a file address/);
  const deep = await blockedText('gemini', pre('run_shell_command', { command: 'ls', extra: nested(10000) }));
  assert.match(deep, /nested too deeply/);
  assert.match(deep, /Next step: ask the agent to send the same action with flatter arguments/);
  assert.doesNotMatch(deep, /changed the format|update zn-gate/);
});

test('Antigravity: an unreadable file address and an action nested too deeply both give the cause and the flatter-call step', async () => {
  const pre = (name, args) => ({ conversationId: 'c', workspacePaths: ['/work/proj'], toolCall: { name, args } });
  assertAdvice(await blockedText('antigravity', pre('mcp_files_write', { a: nested(9) })), /could not read a file address/);
  const deep = await blockedText('antigravity', pre('run_command', { CommandLine: 'ls', extra: nested(10000) }));
  assert.match(deep, /nested too deeply/);
  assert.match(deep, /Next step: ask the agent to send the same action with flatter arguments/);
  assert.doesNotMatch(deep, /changed the format|update zn-gate/);
});
