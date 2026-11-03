'use strict';

// The Python redact_secrets (tests/test_scrub_shell_split_percent.py) reads the same fixture: for every
// case both engines must agree on whether the text holds a secret. Fake values only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { scan } = require('../lib/scrub/engine');

const FIXTURE = path.join(__dirname, 'fixtures', 'scrub_normalised_parity.json');

test('shared fixture with the Python redact_secrets', () => {
  const cases = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')).cases;
  assert.ok(cases.length >= 40);
  for (const c of cases) {
    const found = scan(c.input, { exact: false }).length > 0;
    assert.equal(found, c.redacted, c.name);
  }
});
