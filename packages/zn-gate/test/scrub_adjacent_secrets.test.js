'use strict';
// Two secrets on adjacent lines are two detections, each with its own rule, and a key wrapped across two lines is
// one (same cases as tests/test_scrubber_adjacent_secrets.py in the Python package). Every value is a fictitious key.
const test = require('node:test');
const assert = require('node:assert/strict');
const { redactSecrets } = require('../lib/rules');

// name -> [fake key, rule that reports it]
const KEYS = {
  github: ['ghp_' + 'aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bD1fH3jL5', 'secret:github_token'],
  aws: ['AKIAIOSFODNN7EXAMPLE', 'secret:aws_access_key'],
  anthropic: ['sk-ant-api03-' + 'aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bD1fH3jL5nP7rT9', 'secret:anthropic_key'],
  huggingface: ['hf_' + 'aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bD1fH3j', 'secret:hf_token'],
  npm: ['npm_' + 'aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bD1fH3jL5', 'secret:npm_token'],
  slack: ['xoxb-' + '123456789012-123456789012-aB3dE5gH7jK9mN1pQ3sT5vW7', 'secret:slack_token'],
  stripe: ['sk_live_' + 'aB3dE5gH7jK9mN1pQ3sT5vW7', 'secret:stripe_key'],
  openai: ['sk-proj-' + 'EXAMPLE' + '0'.repeat(28), 'secret:openai_key'],
  pypi: ['pypi-AgE' + 'EXAMPLE' + '0'.repeat(19) + '111122233445566778899BCDFGHNOQR', 'secret:pypi_token'],
};
const BODIES = ['aB3d', 'EXAMPLE'];
const SEPARATORS = [['LF', '\n'], ['CRLF', '\r\n'], ['indented', '\n  ']];
const rulesOf = (r) => r.detections.map((d) => d.rule).sort();
const leaks = (out) => BODIES.filter((b) => out.includes(b));

for (const [sepName, sep] of SEPARATORS) {
  test(`two keys on adjacent lines (${sepName}) are two detections with their own rule names`, () => {
    for (const [a, [first, ruleA]] of Object.entries(KEYS)) {
      for (const [b, [second, ruleB]] of Object.entries(KEYS)) {
        const r = redactSecrets(first + sep + second);
        assert.deepEqual(leaks(r.sanitized), [], `${a} + ${b}: ${r.sanitized}`);
        assert.deepEqual(rulesOf(r), [ruleA, ruleB].sort(), `${a} + ${b}`);
      }
    }
  });
}

test('different keys on adjacent lines keep two rule names', () => {
  const r = redactSecrets(KEYS.openai[0] + '\n' + KEYS.pypi[0]);
  assert.equal(r.sanitized, '[REDACTED_OPENAI_KEY]\n[REDACTED_PYPI_TOKEN]');
  assert.deepEqual(rulesOf(r), ['secret:openai_key', 'secret:pypi_token']);
});

test('three keys on three lines', () => {
  const r = redactSecrets(['openai', 'pypi', 'github'].map((n) => KEYS[n][0]).join('\n'));
  assert.deepEqual(leaks(r.sanitized), [], r.sanitized);
  assert.equal(r.detections.length, 3);
});

for (const name of ['github', 'openai', 'pypi', 'huggingface', 'npm']) {
  for (const cut of [10, 20]) {
    test(`a ${name} key wrapped after ${cut} characters is one detection`, () => {
      const [key, rule] = KEYS[name];
      const r = redactSecrets('token:\n' + key.slice(0, cut) + '\n' + key.slice(cut) + '\n');
      assert.deepEqual(leaks(r.sanitized), [], r.sanitized);
      assert.ok(!r.sanitized.includes(key.slice(cut)) && !r.sanitized.includes(key.slice(0, cut)), r.sanitized);
      assert.deepEqual(rulesOf(r), [rule]);
    });
  }
}

test('a wrapped key then another key is two detections', () => {
  const [key, rule] = KEYS.github;
  const [other, otherRule] = KEYS.pypi;
  const r = redactSecrets(key.slice(0, 20) + '\n' + key.slice(20) + '\n' + other);
  assert.deepEqual(leaks(r.sanitized), [], r.sanitized);
  assert.ok(!r.sanitized.includes(key.slice(20)), r.sanitized);
  assert.deepEqual(rulesOf(r), [rule, otherRule].sort());
});

test('a remainder no rule redacts stays in the joined match', () => {
  // The second line starts like a Hugging Face token but its body is too regular for that rule, so no rule of its own
  // would redact it: the key rule keeps the whole joined match and nothing is left readable.
  const r = redactSecrets('sk-proj-aB3dE5gH7jK9mN1pQ3sT5v\n' + 'hf_' + '0'.repeat(34));
  assert.ok(!r.sanitized.includes('0'.repeat(10)) && !r.sanitized.includes('aB3d'), r.sanitized);
  assert.ok(r.detections.length >= 1);
});
