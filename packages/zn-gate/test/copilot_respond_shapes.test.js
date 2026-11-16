'use strict';

process.env.ZN_STATS = 'off';

// Pins the exact output of the Copilot adapter's respond() for each kind of decision object.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');

const copilot = require('../lib/agents/copilot');

function cwdFor(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-copilot-shapes-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const pre = (cwd, toolName, toolArgs) => copilot.normalize({ cwd, toolName, toolArgs: JSON.stringify(toolArgs) });
const post = (cwd, text, resultType = 'success') =>
  copilot.normalize({ cwd, toolName: 'bash', toolArgs: { command: 'echo hi' }, toolResult: { resultType, textResultForLlm: text } });

test('no decision object, or one without an event, gives no output', () => {
  assert.equal(copilot.respond(null), null);
  assert.equal(copilot.respond(undefined), null);
  assert.equal(copilot.respond({}), null);
  assert.equal(copilot.respond({ decision: 'deny', message: 'x' }), null);
});

test('an event the adapter does not handle gives no output, even for a deny', (t) => {
  const ev = copilot.normalize({ cwd: cwdFor(t), prompt: 'hello' });
  assert.equal(ev.event, null);
  assert.equal(copilot.respond({ event: ev, decision: 'deny', message: 'x' }), null);
});

test('post-tool with updated output gives modifiedResult only', (t) => {
  const ev = post(cwdFor(t), 'original');
  assert.equal(ev.event, 'post_tool');
  assert.deepEqual(copilot.respond({ event: ev, updatedOutput: 'clean' }), {
    modifiedResult: { resultType: 'success', textResultForLlm: 'clean' },
  });
});

test('post-tool with updated output and a message adds additionalContext', (t) => {
  const ev = post(cwdFor(t), 'original');
  assert.deepEqual(copilot.respond({ event: ev, updatedOutput: '', message: 'note' }), {
    modifiedResult: { resultType: 'success', textResultForLlm: '' },
    additionalContext: 'note',
  });
});

test('post-tool without updated output gives no output, even with a message or a deny', (t) => {
  const ev = post(cwdFor(t), 'original');
  assert.equal(copilot.respond({ event: ev }), null);
  assert.equal(copilot.respond({ event: ev, message: 'note' }), null);
  assert.equal(copilot.respond({ event: ev, decision: 'deny', message: 'no' }), null);
  assert.equal(copilot.respond({ event: ev, updatedOutput: 42 }), null);
});

test('deny with a message uses the message as the reason', (t) => {
  const ev = pre(cwdFor(t), 'bash', { command: 'echo hi' });
  assert.deepEqual(copilot.respond({ event: ev, decision: 'deny', message: 'Not allowed here' }), {
    permissionDecision: 'deny',
    permissionDecisionReason: 'Not allowed here',
  });
});

test('deny without a message uses the default reason', (t) => {
  const ev = pre(cwdFor(t), 'bash', { command: 'echo hi' });
  assert.deepEqual(copilot.respond({ event: ev, decision: 'deny' }), {
    permissionDecision: 'deny',
    permissionDecisionReason: 'Blocked by zn',
  });
});

test('an unreadable event is denied with its own reason', (t) => {
  const cwd = cwdFor(t);
  const noCommand = pre(cwd, 'bash', {});
  assert.deepEqual(copilot.respond({ event: noCommand }), {
    permissionDecision: 'deny',
    permissionDecisionReason: 'zn: could not read the command of this call, so zn cannot check it.',
  });
  const noName = copilot.normalize({ cwd, toolArgs: { command: 'echo hi' } });
  assert.deepEqual(copilot.respond({ event: noName }), {
    permissionDecision: 'deny',
    permissionDecisionReason: 'zn: could not read the tool name of this call, so zn cannot check it.',
  });
});

test('a deny decision wins over an unreadable reason', (t) => {
  const ev = pre(cwdFor(t), 'bash', {});
  assert.deepEqual(copilot.respond({ event: ev, decision: 'deny', message: 'first' }), {
    permissionDecision: 'deny',
    permissionDecisionReason: 'first',
  });
});

test('a wrapped command is denied with the zn run instruction', (t) => {
  const ev = pre(cwdFor(t), 'bash', { command: 'deploy --token {{ZN:EXAMPLE}}' });
  const out = copilot.respond({ event: ev, kind: 'wrap', updatedInput: { command: 'rewritten' }, decision: 'allow' });
  assert.deepEqual(Object.keys(out).sort(), ['permissionDecision', 'permissionDecisionReason']);
  assert.equal(out.permissionDecision, 'deny');
  assert.equal(out.permissionDecisionReason,
    'zn: this command uses a stored secret. Run it through zn instead, exactly like this: zn run -- deploy --token {{ZN:EXAMPLE}}' +
    '  (zn puts the value only into that process, if the user allowed this command for the secret).');
});

test('an ask gives the ask decision with the message or the default reason', (t) => {
  const ev = pre(cwdFor(t), 'bash', { command: 'echo hi' });
  assert.deepEqual(copilot.respond({ event: ev, decision: 'ask', message: 'Allow this?' }), {
    permissionDecision: 'ask',
    permissionDecisionReason: 'Allow this?',
  });
  assert.deepEqual(copilot.respond({ event: ev, decision: 'ask' }), {
    permissionDecision: 'ask',
    permissionDecisionReason: 'zn asks for confirmation',
  });
});

test('a rewritten input that is not a wrap is turned into an ask, never applied', (t) => {
  const ev = pre(cwdFor(t), 'bash', { command: 'echo hi' });
  const out = copilot.respond({ event: ev, updatedInput: { command: 'other' }, message: 'Check this' });
  assert.deepEqual(out, { permissionDecision: 'ask', permissionDecisionReason: 'Check this' });
});

test('a pre-tool event with no decision gives no output and never "allow"', (t) => {
  const ev = pre(cwdFor(t), 'bash', { command: 'echo hi' });
  assert.equal(copilot.respond({ event: ev }), null);
  assert.equal(copilot.respond({ event: ev, decision: 'allow' }), null);
});
