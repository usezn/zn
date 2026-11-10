'use strict';
// The scrubber masks a Stripe restricted key (rk_live_) and keeps the name written before it.
// The key is fake: it is assembled from parts so that no literal in this file matches a provider rule.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const P = require(path.resolve(__dirname, '..', 'lib', 'scrub', 'patterns'));
const E = require(path.resolve(__dirname, '..', 'lib', 'scrub', 'engine'));

const KEY = 'rk_' + 'live_' + 'Ab3Cd9Ef2Gh7Jk4Lm8Np1Qr6St0Uv5Wx';

async function masked(text) {
  const r = await E.tokenize(text, {});
  return typeof r === 'string' ? r : r.text;
}

test('the pattern layer finds the restricted key as one span', () => {
  const text = 'STRIPE_RESTRICTED_KEY=' + KEY + '\n';
  const spans = P.findPatterns(text, {}).filter((s) => s.type === 'STRIPE_KEY');
  assert.equal(spans.length, 1);
  assert.equal(text.slice(spans[0].start, spans[0].end), KEY);
});

test('an env line keeps the variable name and masks the value', async () => {
  const out = await masked('STRIPE_RESTRICTED_KEY=' + KEY + '\n');
  assert.equal(out, 'STRIPE_RESTRICTED_KEY=__ZN_REDACTED_STRIPE_KEY__\n');
  assert.ok(!out.includes(KEY));
});

test('a JSON field keeps the key name and masks the value', async () => {
  const out = await masked('{"stripe_restricted_key": "' + KEY + '"}\n');
  assert.equal(out, '{"stripe_restricted_key": "__ZN_REDACTED_STRIPE_KEY__"}\n');
  assert.ok(!out.includes('rk_live_'));
});
