'use strict';

// Direct tests for the two helpers in lib/agents/ask-deny.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const { askAsDeny, isPlainAsk } = require('../lib/agents/ask-deny');

test('askAsDeny uses the decision message and names the agent', () => {
  const out = askAsDeny('Codex', { message: 'zn: reads a key file' });
  assert.ok(out.startsWith('zn: reads a key file Codex cannot show that question'));
  assert.match(out, /zn blocked the action instead/);
  assert.match(out, /do not retry the same action on your own/);
});

test('askAsDeny falls back to a default reason', () => {
  for (const d of [undefined, null, {}, { message: '' }]) {
    assert.ok(askAsDeny('Gemini', d).startsWith('zn needs your confirmation for this action. Gemini cannot'));
  }
});

test('isPlainAsk accepts a bare ask', () => {
  assert.equal(isPlainAsk({ decision: 'ask' }), true);
});

test('isPlainAsk rejects non-ask decisions and empty input', () => {
  assert.equal(isPlainAsk({ decision: 'deny' }), false);
  assert.equal(isPlainAsk({ decision: 'allow', confirm: true }), false);
  assert.equal(isPlainAsk(null), false);
  assert.equal(isPlainAsk(undefined), false);
});

test('isPlainAsk rejects rewrite proposals and soft asks', () => {
  assert.equal(isPlainAsk({ decision: 'ask', updatedInput: { command: 'x' } }), false);
  assert.equal(isPlainAsk({ decision: 'ask', soft: true }), false);
});

test('isPlainAsk keeps a confirmed question even with a rewrite or soft flag', () => {
  assert.equal(isPlainAsk({ decision: 'ask', confirm: true, updatedInput: { command: 'x' } }), true);
  assert.equal(isPlainAsk({ decision: 'ask', confirm: true, soft: true }), true);
  assert.equal(isPlainAsk({ decision: 'ask', confirm: 'yes', soft: true }), false);
});
