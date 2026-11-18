'use strict';

// Cursor (cursor.com/docs/agent/hooks, re-read 2026-11-17): "For permission hooks (beforeShellExecution,
// beforeMCPExecution, beforeReadFile, beforeTabFileRead, subagentStart, preToolUse), invalid JSON or a response that
// doesn't match the hook's schema blocks the action." So the adapter must never print nothing on those events: every
// decision it can reach (allow, deny, ask, a soft question, a rewrite proposal, an unreadable call) maps to a valid answer.

const test = require('node:test');
const assert = require('node:assert/strict');
const { getAdapter } = require('../lib/agents');

const cursor = getAdapter('cursor');
const RAW = {
  beforeReadFile: { file_path: '/work/src/index.js', content: 'x' },
  beforeShellExecution: { command: 'echo hello', cwd: '/work' },
  beforeMCPExecution: { tool_name: 'query', mcp_server_name: 'db', tool_input: '{"sql":"select 1"}' },
  preToolUse: { tool_name: 'Write', tool_input: { file_path: '/work/src/a.js', content: 'x' } },
};
const DECISIONS = {
  allow: { decision: 'allow' },
  deny: { decision: 'deny', message: 'no' },
  ask: { decision: 'ask', message: 'sure?' },
  softAsk: { decision: 'ask', soft: true, message: 'zn: placeholders' },
  rewrite: { decision: 'ask', updatedInput: { command: 'y' }, kind: 'restore', message: 'zn: puts back a value' },
  wrap: { decision: 'allow', updatedInput: { command: 'zn run -- echo' }, kind: 'wrap' },
};
const ev = (event, extra) => cursor.normalize({ conversation_id: 'c', generation_id: 'g', workspace_roots: ['/work'], cwd: '/work', hook_event_name: event, ...RAW[event], ...extra });

// The documented permission answer: {permission: allow|deny|ask} (beforeReadFile: allow|deny only), JSON-serializable.
function assertValid(event, a, label) {
  assert.ok(a && typeof a === 'object', label + ': a permission hook must answer, empty output blocks');
  const allowed = event === 'beforeReadFile' ? ['allow', 'deny'] : ['allow', 'deny', 'ask'];
  assert.ok(allowed.includes(a.permission), label + ': ' + JSON.stringify(a));
  assert.deepEqual(JSON.parse(JSON.stringify(a)), a, label + ': not plain JSON');
  for (const k of ['user_message', 'agent_message']) assert.ok(a[k] === undefined || typeof a[k] === 'string', label + ' ' + k);
}

test('every permission hook answers with a schema-valid permission for every decision zn can reach', () => {
  for (const event of Object.keys(RAW)) {
    for (const [name, d] of Object.entries(DECISIONS)) assertValid(event, cursor.respond({ ...d, event: ev(event) }), event + '/' + name);
  }
});

test('no objection is an explicit allow on shell, MCP, file read and preToolUse', () => {
  for (const event of Object.keys(RAW)) assert.deepEqual(cursor.respond({ decision: 'allow', event: ev(event) }), { permission: 'allow' }, event);
});

test('deny and ask keep their documented shape', () => {
  const d = cursor.respond({ decision: 'deny', message: 'no', event: ev('beforeShellExecution') });
  assert.deepEqual(d, { permission: 'deny', user_message: 'no', agent_message: 'no' });
  const q = cursor.respond({ decision: 'ask', message: 'sure?', event: ev('beforeShellExecution') });
  assert.equal(q.permission, 'ask');
  assert.equal(q.user_message, 'sure?');
  // beforeReadFile has no ask: a question becomes a deny.
  assert.equal(cursor.respond({ decision: 'ask', message: 'sure?', event: ev('beforeReadFile') }).permission, 'deny');
});

test('a call zn cannot read is denied with a valid answer, not left silent', () => {
  assertValid('preToolUse', cursor.respond({ decision: 'allow', event: ev('preToolUse', { tool_input: {} }) }), 'write without path');
  assert.equal(cursor.respond({ decision: 'allow', event: ev('preToolUse', { tool_input: {} }) }).permission, 'deny');
  assert.equal(cursor.respond({ decision: 'allow', event: ev('preToolUse', { tool_name: '' }) }).permission, 'deny');
  assert.equal(cursor.respond({ decision: 'allow', event: ev('beforeReadFile', { file_path: undefined }) }).permission, 'deny');
});

test('events that are not permission hooks may stay silent', () => {
  const post = cursor.normalize({ conversation_id: 'c', hook_event_name: 'postToolUse', tool_name: 'Shell', tool_input: {}, tool_output: '{}' });
  assert.equal(cursor.respond({ decision: 'allow', event: post }), null);
  assert.equal(cursor.respond({ decision: 'allow', event: null }), null);
});
