'use strict';
/* A prompt block names the credential kind, and a value that says it is a
 * placeholder passes. The text of a blocked value is never shown. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { decidePrompt } = require('../lib/hooks/runner');
const { findPromptAssignments } = require('../lib/scrub/prompt');

function deps(spans = []) {
  return { engine: () => ({ scan: () => spans }), vault: async () => null, detectors: () => [] };
}

test('a generic detection is named by the key written before its value', async () => {
  const value = 'Qz7rW9pL2mNx';
  const prompt = 'set password = "' + value + '" in the config';
  const span = { start: prompt.indexOf(value), end: prompt.indexOf(value) + value.length, type: 'SECRET', source: 'pattern' };
  const d = await decidePrompt({ event: 'user_prompt', input: { prompt } }, deps([span]), 'claude-code');
  assert.equal(d.decision, 'deny');
  assert.match(d.message, /contains a secret \(PASSWORD\)/);
  assert.match(d.message, /secret set PASSWORD,/);
  assert.doesNotMatch(d.message, /Qz7rW9pL2mNx/);
});

test('a generic detection with no key before it keeps the generic kind', async () => {
  const value = 'Qz7rW9pL2mNx';
  const prompt = 'here it is ' + value + ' ok';
  const span = { start: prompt.indexOf(value), end: prompt.indexOf(value) + value.length, type: 'SECRET', source: 'pattern' };
  const d = await decidePrompt({ event: 'user_prompt', input: { prompt } }, deps([span]), 'claude-code');
  assert.match(d.message, /contains a secret \(a secret\)/);
  assert.doesNotMatch(d.message, /Qz7rW9pL2mNx/);
});

test('a typed kind is not renamed by a key before its value', async () => {
  const value = 'AKIAIOSFODNN7EXAMPLE';
  const prompt = 'api_key=' + value + ' is in the file';
  const span = { start: prompt.indexOf(value), end: prompt.indexOf(value) + value.length, type: 'AWS_KEY', source: 'pattern' };
  const d = await decidePrompt({ event: 'user_prompt', input: { prompt } }, deps([span]), 'claude-code');
  assert.match(d.message, /contains a secret \(an AWS key\)/);
});

test('a fake placeholder value such as STRIPE_KEY=FAKE_NOT_A_REAL_KEY_1234 is not blocked', async () => {
  const prompt = 'my key is STRIPE_KEY=FAKE_NOT_A_REAL_KEY_1234, can you check it?';
  assert.deepEqual(findPromptAssignments(prompt), []);
  const d = await decidePrompt({ event: 'user_prompt', input: { prompt } }, deps([]), 'claude-code');
  assert.equal(d.decision, 'allow');
});
