'use strict';

// The keyed-field prefilter (X-Name: ...) must stay linear on a long run of
// whitespace after a header-like name, and keep matching what it always matched.

const test = require('node:test');
const assert = require('node:assert/strict');
const { findPii } = require('../lib/scrub/patterns');

function ms(fn) {
  const t0 = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

test('a long run of spaces after a header name is scanned in linear time', () => {
  const inputs = [
    'X-abcd' + ' '.repeat(200000),
    'X-abcd' + ' '.repeat(200000) + '"' + ' '.repeat(200000),
    'X-abcd' + '\t '.repeat(100000),
    'X-abcd '.repeat(30000),
    ('X-abcd' + ' '.repeat(50) + '"').repeat(3000),
    'X-' + 'a-'.repeat(60000) + ' '.repeat(1000),
  ];
  for (const text of inputs) {
    const t = ms(() => findPii(text));
    assert.ok(t < 1000, `took ${t} ms on a ${text.length}-character input`);
  }
});

test('the keyed headers are still found with spaces and quotes before the colon', () => {
  for (const text of ['X-User-Name: Maria Garcia', 'X-User-Name  :  Maria Garcia', '{"X-User-Name" : "Maria Garcia"}', 'X-User-Name" : Maria Garcia']) {
    const hits = findPii(text).filter((h) => h.type === 'PERSON_NAME');
    assert.equal(hits.length, 1, text);
    assert.match(text.slice(hits[0].start, hits[0].end), /^Maria Garcia$/, text);
  }
});
