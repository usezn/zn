'use strict';

// Parity with the Rust engine and the Python engine: every engine reads the same
// cases (packages/zn-gate/test/fixtures/credentials_request_cases.json) and must
// give the same answer for the exfil:credentials rule.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EXFIL_RULES } = require('../lib/rules.js');

const cases = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'credentials_request_cases.json'), 'utf8')
);
const rule = EXFIL_RULES.find((r) => r.id === 'exfil:credentials');
const matches = (text) => rule.compound.every((re) => re.test(text));

test('the shared credentials-request cases match the rule', () => {
  assert.ok(cases.block.length > 0);
  for (const text of cases.block) assert.equal(matches(text), true, text);
});

test('the shared descriptions do not match the rule', () => {
  assert.ok(cases.allow.length > 0);
  for (const text of cases.allow) assert.equal(matches(text), false, text);
});
