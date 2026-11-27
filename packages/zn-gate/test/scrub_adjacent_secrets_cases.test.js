'use strict';
// The shared corpus of keys on adjacent lines, wrapped across lines, or both (test/fixtures/adjacent_secrets_cases.json,
// made by test/helpers/make_adjacent_secret_cases.js). The Python package runs the same file in
// tests/test_adjacent_secrets_cases.py, so both engines report the same rules and leave no part of a key readable.
// Every key is fictitious.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { redactSecrets } = require('../lib/rules');

const cases = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'adjacent_secrets_cases.json'), 'utf8'));

// Any 8 characters in a row of a key that are still in the output.
function readableFragment(out, keys) {
  for (const key of keys) {
    for (let i = 0; i + 8 <= key.length; i++) if (out.includes(key.slice(i, i + 8))) return key.slice(i, i + 8);
  }
  return null;
}

test('the corpus is not empty and every case has a text and keys', () => {
  assert.ok(cases.length > 400);
  for (const c of cases) assert.ok(c.id && c.text && c.keys.length > 0 && Array.isArray(c.rules), c.id);
});

test('adjacent and wrapped keys: one detection per key with its own rule, no part of a key readable', () => {
  const failures = [];
  for (const c of cases) {
    const r = redactSecrets(c.text);
    const rules = r.detections.map((d) => d.rule).sort();
    const left = readableFragment(r.sanitized, c.keys);
    const lost = c.keep.filter((k) => !r.sanitized.includes(k));
    if (left || lost.length || JSON.stringify(rules) !== JSON.stringify(c.rules)) {
      failures.push(`${c.id}: rules ${JSON.stringify(rules)} want ${JSON.stringify(c.rules)}${left ? ', readable ' + left : ''}${lost.length ? ', lost ' + lost : ''}`);
    }
  }
  assert.deepEqual(failures, []);
});
