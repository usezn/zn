'use strict';

// Path separators of Windows, hidden elements, openssl decode forms and
// characters without a fold mapping. The cases are shared with the Python
// test (test_rules_r3_r6.py).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const rules = require('../lib/rules');

const CASES = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'rules_r3_r6_cases.json'), 'utf8'));
const hiddenRule = rules.INDIRECT_INJECTION_RULES.find((r) => r.id === 'indirect:hidden_tag');

test('sensitive files are matched with Windows and mixed separators', () => {
  for (const text of CASES.sensitive_file.positives) {
    const r = rules.evaluate(text);
    assert.equal(r.verdict, 'block', text);
    assert.equal(r.rule, 'path:sensitive_file', text);
  }
  for (const text of CASES.sensitive_file.benign) {
    assert.notEqual(rules.evaluate(text).rule, 'path:sensitive_file', text);
  }
});

test('indirect:hidden_tag needs an element that is really hidden', () => {
  for (const text of CASES.hidden_tag.positives) assert.equal(hiddenRule.test(text), true, text);
  for (const text of CASES.hidden_tag.benign) assert.equal(hiddenRule.test(text), false, text);
});

test('a hidden element with a payload blocks', () => {
  for (const text of CASES.hidden_tag.positives) {
    const r = rules.evaluate(text);
    assert.equal(r.verdict, 'block', text);
  }
});

test('openssl counts as a Base64 decoder only in its decode forms', () => {
  const { payload, decode, not_decode: notDecode } = CASES.openssl;
  for (const form of decode) {
    const r = rules.evaluate(`echo ${payload} | ${form}`);
    assert.equal(r.verdict, 'block', form);
    assert.equal(r.rule, 'evasion:base64_smuggling', form);
  }
  for (const form of notDecode) {
    const r = rules.evaluate(`echo ${payload} | ${form}`);
    assert.notEqual(r.rule, 'evasion:base64_smuggling', form);
  }
});

test('a character without a fold mapping is kept', () => {
  for (const text of CASES.compat_fold.kept) {
    const { stripped } = rules.normalizeInput(text);
    assert.equal(stripped, text);
    assert.ok(!stripped.includes('undefined'), text);
  }
  for (const [input, folded] of CASES.compat_fold.folded) {
    assert.equal(rules.normalizeInput(input).stripped, folded);
  }
});
