'use strict';

// A Datadog API key (32 hex digits) on a DD_API_KEY line is masked, and the
// name stays readable. The value is fake and built at run time from parts, so
// no key-shaped literal sits in the source.

const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../lib/scrub/engine');

const FAKE_DATADOG_KEY = ['a7f3c9e1b04d82f6', '5e9c1a3b7d2f8e40'].join('');

test('a Datadog API key on a DD_API_KEY line is masked and the name is kept', () => {
  const text = 'DD_API_KEY=' + FAKE_DATADOG_KEY;
  const spans = E.scan(text, { exactFiles: false });
  assert.equal(spans.length, 1, JSON.stringify(spans));
  assert.equal(text.slice(spans[0].start, spans[0].end), FAKE_DATADOG_KEY);
  assert.equal(text.slice(0, spans[0].start), 'DD_API_KEY=');
});
