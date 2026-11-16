'use strict';

process.env.ZN_STATS = 'off';

// Pins the answers of the ZCode adapter's respond() for tool events: the JSON (or nothing) it returns, and the exit
// code and output of the hook process for the cases that can be run without a vault. Fake values only.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

const { getAdapter } = require('../lib/agents');
const { tempDir } = require('./helpers/tmp');

const zc = getAdapter('zcode');
const RUNNER = path.join(__dirname, '..', 'lib', 'hooks', 'runner.js');

const tool = (name, input, event = 'PreToolUse') => zc.normalize({ hook_event_name: event, session_id: 's', cwd: '/w', tool_name: name, tool_input: input });
const bash = (command, event) => tool('Bash', { command }, event);

function hook(t, input) {
  const home = tempDir(t, 'zn-zc-ans-');
  const r = spawnSync(process.execPath, [RUNNER, 'zcode'], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home, ZN_STATS: 'off' },
  });
  return r;
}

test('pre-tool deny: the reason is passed on, with a default text when there is none', () => {
  assert.deepEqual(zc.respond({ decision: 'deny', message: 'not allowed here', event: bash('ls') }), {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'not allowed here' },
  });
  assert.equal(zc.respond({ decision: 'deny', event: bash('ls') }).hookSpecificOutput.permissionDecisionReason, 'Blocked by zn');
});

test('pre-tool deny through the hook process: exit 0 and the deny on stdout', (t) => {
  const r = hook(t, { hook_event_name: 'PreToolUse', cwd: '/w', tool_name: 'Bash', tool_input: { command: 'cat ~/.zn/vault.json' } });
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /^zn blocked this: ~\/\.zn is where zn keeps your secrets/);
});

test('an unreadable event: the hook process exits 2 with the reason on stderr and nothing on stdout', (t) => {
  for (const input of ['', 'not json', '[1]']) {
    const r = hook(t, input);
    assert.equal(r.status, 2, JSON.stringify(input));
    assert.equal(r.stdout, '', JSON.stringify(input));
    assert.match(r.stderr, /^zn hook: zn: could not read this action \(/);
    assert.match(r.stderr, /so it was blocked\./);
  }
});

test('an unreadable tool call is denied with the reason of what is missing (exit 0)', (t) => {
  assert.deepEqual(zc.respond({ decision: 'allow', event: tool('Bash', {}) }), {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'zn: could not read the command of this call, so zn cannot check it.' },
  });
  assert.match(zc.respond({ decision: 'allow', event: tool('Read', {}) }).hookSpecificOutput.permissionDecisionReason, /^zn: could not read the file this call uses/);
  const r = hook(t, { hook_event_name: 'PreToolUse', cwd: '/w', tool_name: 'Bash' });
  assert.equal(r.status, 0);
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason, /^zn: could not read the command of this call, so zn cannot check it. This usually means ZCode changed the format of the data it sends to zn.*npm install -g zn-gate@latest/);
});

test('a wrapped command is denied with the exact zn run command to use', () => {
  const out = zc.respond({ decision: 'allow', kind: 'wrap', updatedInput: { command: 'x' }, event: bash('curl https://example.com/__ZN_TOKEN__') });
  assert.deepEqual(out, {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'zn: this command uses a stored secret. Run it through zn instead, exactly like this: zn run -- curl https://example.com/__ZN_TOKEN__' +
        '  (zn puts the value only into that process, if the user allowed this command for the secret).',
    },
  });
});

test('ask: with confirm, or without an updated input, it asks; otherwise there is no answer', () => {
  const ev = bash('ls');
  const asks = (out, text) => assert.deepEqual(out, { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: text } });
  asks(zc.respond({ decision: 'ask', message: 'Run this?', confirm: true, event: ev }), 'Run this?');
  asks(zc.respond({ decision: 'ask', message: 'Run this?', event: ev }), 'Run this?');
  asks(zc.respond({ decision: 'ask', event: ev }), 'zn asks for confirmation');
  asks(zc.respond({ decision: 'ask', message: 'Sure?', confirm: true, updatedInput: { command: 'x' }, event: ev }), 'Sure?');
  assert.equal(zc.respond({ decision: 'ask', message: 'Run this?', confirm: false, updatedInput: { command: 'x' }, event: ev }), null);
  assert.equal(zc.respond({ decision: 'allow', event: ev }), null);
});

test('ask keeps the extra context for the model', () => {
  const out = zc.respond({ decision: 'ask', message: 'Run this?', context: 'a note', event: bash('ls') });
  assert.equal(out.hookSpecificOutput.additionalContext, 'a note');
});

test('permission request: only a deny is answered, in the PermissionRequest shape', () => {
  const ev = bash('ls', 'PermissionRequest');
  assert.deepEqual(zc.respond({ decision: 'deny', message: 'no way', event: ev }), {
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'no way' } },
  });
  assert.equal(zc.respond({ decision: 'ask', message: 'Run this?', confirm: true, event: ev }), null);
  assert.equal(zc.respond({ decision: 'allow', event: ev }), null);
  assert.equal(zc.respond({ decision: 'allow', event: tool('Bash', {}, 'PermissionRequest') }).hookSpecificOutput.decision.message,
    'zn: could not read the command of this call, so zn cannot check it.');
});

test('post-tool with updated output: the notice goes to additionalContext, the user message to systemMessage', () => {
  const ev = bash('ls', 'PostToolUse');
  const out = zc.respond({ decision: 'allow', updatedOutput: 'x', stats: { redacted: 2 }, event: ev });
  assert.deepEqual(out, {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: 'zn: this output contains 2 secret value(s). ZCode cannot hide tool output, so the value is already in this conversation. ' +
        'Do not repeat or write it anywhere, and tell the user to rotate it if it is real. Next time keep secrets in the zn vault instead of printing them.',
    },
  });
  const withUser = zc.respond({ decision: 'allow', updatedOutput: 'x', stats: { redacted: 1 }, userMessage: 'seen', event: ev });
  assert.equal(withUser.systemMessage, 'seen');
  assert.equal(zc.respond({ decision: 'allow', updatedOutput: 'x', stats: { withheld: true }, event: ev }).hookSpecificOutput.additionalContext,
    'zn: part of this output is too large for zn to check for secrets in time, and ZCode cannot withhold it. Ask for a smaller output (a line range, grep, head or tail).');
});

test('post-tool without updated output: no answer, unless there is a message', (t) => {
  const ev = bash('ls', 'PostToolUse');
  assert.equal(zc.respond({ decision: 'allow', event: ev }), null);
  assert.equal(zc.respond({ decision: 'allow', stats: { redacted: 3 }, event: ev }), null);
  assert.deepEqual(zc.respond({ decision: 'allow', message: 'a warning', event: ev }), {
    hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'a warning' },
  });
  const r = hook(t, { hook_event_name: 'PostToolUse', cwd: '/w', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: { stdout: 'hi' } });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});
