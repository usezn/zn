'use strict';

// The Rust scrubber (tests/scrubber_key_names.rs) reads the same list of key
// names, so the two scrubbers cannot drift apart on which names they redact.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const engine = require('../lib/scrub/engine');

const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'scrub_key_names_parity.json'), 'utf8'));

test('the shared key-name list is not empty', () => {
  assert.ok(FIXTURE.redacted_names.length >= 20);
  assert.equal(new Set(FIXTURE.redacted_names).size, FIXTURE.redacted_names.length);
});

test('the Node scrubber redacts every shared key name', () => {
  for (const name of FIXTURE.redacted_names) {
    for (const text of [`${name}=${FIXTURE.value}`, `${name}: ${FIXTURE.value}`]) {
      const found = engine.scan(text);
      const at = text.indexOf(FIXTURE.value);
      assert.ok(
        found.some((d) => d.start <= at && d.end >= at + FIXTURE.value.length),
        `not redacted: ${name}`,
      );
    }
  }
});
