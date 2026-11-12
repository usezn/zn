'use strict';

// "forget the instructions" and its close variants block as pi:forget; the benign twins stay allowed.
// The same cases run in the Python tests and in the cargo tests of the Rust prompt guard.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { evaluate } = require('../lib/rules');

const cases = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'forget_instruction_cases.json'), 'utf8'));

test('forget-the-instructions attacks block as pi:forget', () => {
  assert.ok(cases.attacks.length > 5);
  for (const text of cases.attacks) {
    const r = evaluate(text);
    assert.equal(r.verdict, 'block', text);
    assert.equal(r.rule, 'pi:forget', text);
  }
});

test('benign twins of the forget phrases stay allowed', () => {
  assert.ok(cases.benign.length > 5);
  for (const text of cases.benign) {
    assert.equal(evaluate(text).verdict, 'allow', text);
  }
});
