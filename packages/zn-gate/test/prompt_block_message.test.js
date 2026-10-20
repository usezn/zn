'use strict';
/* A prompt block names the credential kind, and a value that says it is a
 * placeholder passes. The text of a blocked value is never shown. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { decidePrompt } = require('../lib/hooks/runner');
const { findPromptAssignments } = require('../lib/scrub/prompt');

function deps(spans = []) {
  // The mock scans only the whole prompt (a short candidate name yields nothing).
  const last = spans.reduce((m, x) => Math.max(m, x.end), 0);
  return { engine: () => ({ scan: (t) => (String(t).length >= last ? spans : []) }), vault: async () => null, detectors: () => [] };
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

function span(prompt, value, type = 'SECRET') {
  const start = prompt.indexOf(value);
  return { start, end: start + value.length, type, source: 'pattern' };
}

test('a neighbouring secret is never used as the name (id:secret pair)', async () => {
  const id = 'AKIAIOSFODNN7EXAMPLE';
  const secret = 'Qz7rW9pL2mNxVb4Kd8Tf';
  const prompt = 'use ' + id + ':' + secret + ' for the upload';
  const d = await decidePrompt({ event: 'user_prompt', input: { prompt } },
    deps([span(prompt, id, 'AWS_KEY'), span(prompt, secret)]), 'claude-code');
  assert.equal(d.decision, 'deny');
  assert.doesNotMatch(d.message, new RegExp(id));
  assert.doesNotMatch(d.message, new RegExp(secret));
  assert.match(d.message, /contains a secret \(an AWS key, a secret\)/);
});

test('a neighbouring secret that is not detected but looks random is not a name', async () => {
  const id = 'cid9fK2xQ7LmP4vT8';
  const secret = 'csecZr5Wn3Yb1Hd6Jq';
  const prompt = 'client ' + id + ':' + secret + ' here';
  const d = await decidePrompt({ event: 'user_prompt', input: { prompt } }, deps([span(prompt, secret)]), 'claude-code');
  assert.doesNotMatch(d.message, new RegExp(id, 'i'));
  assert.doesNotMatch(d.message, new RegExp(secret));
  assert.match(d.message, /contains a secret \(a secret\)/);
  assert.match(d.message, /secret set MY_SECRET,/);
});

test('client_id:client_secret with a detected id shows no value', async () => {
  const id = 'fakeclientid0001';
  const secret = 'Qz7rW9pL2mNxVb4Kd8Tf';
  const prompt = 'creds ' + id + ':' + secret;
  const d = await decidePrompt({ event: 'user_prompt', input: { prompt } },
    deps([span(prompt, id), span(prompt, secret)]), 'claude-code');
  assert.doesNotMatch(d.message, new RegExp(id, 'i'));
  assert.doesNotMatch(d.message, new RegExp(secret));
});
