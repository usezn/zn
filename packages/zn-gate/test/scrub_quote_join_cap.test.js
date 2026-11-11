'use strict';

// Dense shell quote pairs ("a''a") are joined for the secret scan, but the number of joins is
// capped. An input at the post-tool scan cap must stay bounded, and a secret after the dense part
// must still be found. Values are synthetic.

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalisedView, MAX_QUOTE_JOINS } = require('../lib/scrub/normalize');
const { findPatterns } = require('../lib/scrub/patterns');

const V = 'fakeSecretValue1234';
const SCAN_CAP = 8 * 1024 * 1024; // runner.js POST_SCAN_CAP

test('quote joins are capped, so a dense input at the scan cap stays bounded', () => {
  const dense = "a''a".repeat(SCAN_CAP / 4);
  const started = Date.now();
  const norm = normalisedView(dense);
  const elapsed = Date.now() - started;
  assert.ok(norm, 'dense input still gets a view');
  assert.ok(norm.marks.length <= MAX_QUOTE_JOINS, 'joins = ' + norm.marks.length);
  assert.ok(norm.clean.length <= dense.length, 'view is not longer than the input');
  assert.ok(elapsed < 20000, 'normalisation took ' + elapsed + ' ms');
});

test('a secret after the dense quote part is still caught', () => {
  const dense = "a''a".repeat(SCAN_CAP / 4);
  const text = dense + '\nexport api_key=' + V + '\n';
  const at = text.indexOf(V);
  const spans = findPatterns(text);
  const hit = spans.some((s) => s.start <= at && s.end >= at + V.length);
  assert.ok(hit, 'secret after the cap is redacted');
});
