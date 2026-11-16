'use strict';

// The Python package masks the same personal values in the preview of `zn-gate test` (find_pii_spans in
// packages/zn-gate-py/src/zn_gate/rules.py, checked by packages/zn-gate-py/tests/test_pii_parity.py). Both
// suites read test/fixtures/pii_parity_cases.json: texts with invented values and the spans (type, value)
// that this scrubber finds in each. A deliberate change here refreshes the file with
// ZN_UPDATE_PII_PARITY=1 node --test test/pii_parity.test.js, and the Python port must follow.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const engine = require('../lib/scrub/engine');

const FILE = path.join(__dirname, 'fixtures', 'pii_parity_cases.json');
const fixture = JSON.parse(fs.readFileSync(FILE, 'utf8'));

function spansOf(text) {
  return engine.scan(text, { exact: false }).slice().sort((a, b) => a.start - b.start)
    .map((s) => { assert.equal(s.source, 'pii', `a non-PII span in ${JSON.stringify(text)}`); return [s.type, text.slice(s.start, s.end)]; });
}

if (process.env.ZN_UPDATE_PII_PARITY === '1') {
  const cases = fixture.cases.map((c) => ({ text: c.text, spans: spansOf(c.text) }));
  fs.writeFileSync(FILE, '{"_comment":' + JSON.stringify(fixture._comment) + ',"cases":[\n' + cases.map((c) => JSON.stringify(c)).join(',\n') + '\n]}\n');
}

test('the PII corpus has cases of every ported type', () => {
  const seen = new Set(fixture.cases.flatMap((c) => c.spans.map((s) => s[0])));
  for (const t of ['EMAIL', 'PHONE', 'IBAN', 'CARD', 'DNI', 'NIE', 'SSN']) assert.ok(seen.has(t), t);
});

fixture.cases.forEach((c, i) => {
  test(`PII spans of case ${i} equal the shared fixture`, () => {
    assert.deepEqual(spansOf(c.text), JSON.parse(JSON.stringify(c.spans)));
  });
});
