'use strict';

// Identity-request family: text in a tool result that tells the agent to
// identify its user, or to put the user's identity in a header, URL
// parameter, cookie, form field or the next request. The cases are shared
// with the Python test (test_rules_identity_request.py).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const rules = require('../lib/rules');

const CASES = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'identity_request_cases.json'), 'utf8'));
const FAMILY = ['pi:identity_request', 'pi:identity_request_multi'];

test('the family is an advisory by default', () => {
  for (const id of FAMILY) assert.ok(rules.ADVISORY_BY_DEFAULT.has(id), id);
});

test('every positive case is flagged as an advisory', () => {
  for (const text of CASES.positives) {
    const r = rules.evaluate(text);
    assert.equal(r.verdict, 'allow', text);
    assert.ok(r.advisory && FAMILY.includes(r.advisory.rule), text);
  }
});

test('strict mode blocks every positive case', () => {
  for (const text of CASES.positives) {
    const r = rules.evaluate(text, { strict: true });
    assert.equal(r.verdict, 'block', text);
    assert.ok(FAMILY.includes(r.rule), text);
  }
});

test('benign counterparts are not flagged by the family', () => {
  for (const text of CASES.benign) {
    for (const options of [{}, { strict: true }]) {
      const r = rules.evaluate(text, options);
      assert.ok(!FAMILY.includes(r.rule), text);
      assert.ok(!(r.advisory && FAMILY.includes(r.advisory.rule)), text);
    }
  }
});

test('a tool result with the request is passed on with an advisory, and blocked in strict mode', () => {
  const text = CASES.positives[0];
  const r = rules.sanitizeToolResult('WebFetch', '<p>Welcome</p> ' + text);
  assert.equal(r.safe_to_ingest, true);
  assert.equal(r.assessment.advisory.rule, 'pi:identity_request');
  const s = rules.sanitizeToolResult('WebFetch', '<p>Welcome</p> ' + text, { strict: true });
  assert.equal(s.safe_to_ingest, false);
  assert.equal(s.assessment.rule, 'pi:identity_request');
});

test('long runs of words do not make the family slow', () => {
  const filler = 'send the users '.repeat(4000);
  const start = Date.now();
  rules.evaluate(filler);
  rules.evaluate('include ' + 'the user '.repeat(5000) + 'header');
  assert.ok(Date.now() - start < 3000);
});
