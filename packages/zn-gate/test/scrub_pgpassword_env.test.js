'use strict';

// The scrubber masks the value of a PGPASSWORD assignment, both as an inline
// prefix before a command and as a shell export. The name stays visible.
// Values are synthetic and built from pieces at run time.

const test = require('node:test');
const assert = require('node:assert/strict');
const { findPatterns } = require('../lib/scrub/patterns');

const VALUE = 'Zx9' + 'kQ2mN8pL' + '4rT6vW1y' + 'Hc5J0';

function redacted(text) {
  const spans = findPatterns(text);
  let out = text;
  for (const s of spans.slice().sort((a, b) => b.start - a.start)) out = out.slice(0, s.start) + '#' + out.slice(s.end);
  return out;
}

const CAUGHT = [
  'PGPASSWORD=' + VALUE,
  'export PGPASSWORD=' + VALUE,
  'export PGPASSWORD="' + VALUE + '"',
  'PGPASSWORD=' + VALUE + ' psql -h db.example.com app',
];

test('scrubber masks the value of a PGPASSWORD assignment', () => {
  for (const text of CAUGHT) {
    const out = redacted(text);
    assert.ok(!out.includes(VALUE), 'not redacted: ' + text);
    assert.ok(out.includes('#'), 'no detection: ' + text);
  }
});

test('the redaction keeps the PGPASSWORD name and the command around the value', () => {
  assert.equal(redacted('PGPASSWORD=' + VALUE), 'PGPASSWORD=#');
  assert.equal(redacted('export PGPASSWORD=' + VALUE), 'export PGPASSWORD=#');
  assert.equal(redacted('PGPASSWORD=' + VALUE + ' psql -h db.example.com app'), 'PGPASSWORD=# psql -h db.example.com app');
});
