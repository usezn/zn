'use strict';

// Dense shell quote pairs ("a''a") are joined for the secret scan. There is no cap on the number of
// joins (a cap would leave the rest of the text unjoined, where a secret would look clean), so the
// work must stay linear: an input at the post-tool scan cap is normalised in bounded time, and a
// secret after the dense part is still found. Values are synthetic.

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalisedView } = require('../lib/scrub/normalize');
const { findPatterns } = require('../lib/scrub/patterns');

const V = 'fakeSecretValue1234';
const SCAN_CAP = 8 * 1024 * 1024; // runner.js POST_SCAN_CAP

test('a dense quote input at the scan cap is joined in bounded time', () => {
  const dense = "a''a".repeat(SCAN_CAP / 4);
  const started = Date.now();
  const norm = normalisedView(dense);
  const elapsed = Date.now() - started;
  assert.ok(norm, 'dense input still gets a view');
  assert.ok(norm.marks.length <= dense.length / 4, 'at most one join per quote pair: ' + norm.marks.length);
  assert.ok(norm.clean.length <= dense.length, 'view is not longer than the input');
  assert.ok(elapsed < 20000, 'normalisation took ' + elapsed + ' ms');
});

test('a secret after the dense quote part is still caught', () => {
  const dense = "a''a".repeat(SCAN_CAP / 4);
  const text = dense + '\nexport api_key=' + V + '\n';
  const at = text.indexOf(V);
  const spans = findPatterns(text);
  const hit = spans.some((s) => s.start <= at && s.end >= at + V.length);
  assert.ok(hit, 'secret after the dense part is redacted');
});
