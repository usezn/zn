'use strict';
// The hook latency budget: a case over the limit, a new case and a case that disappeared all fail.
const test = require('node:test');
const assert = require('node:assert/strict');
const { compare } = require('./hook_latency_gate');

const base = { results: [{ agent: 'codex', case: 'PreToolUse Bash', ratio: 2 }, { agent: 'cursor', case: 'postToolUse MCP 1 KB', ratio: 3 }] };
const report = (a, b, extra = []) => ({ results: [{ agent: 'codex', case: 'PreToolUse Bash', p95: 1, ratio: a }, { agent: 'cursor', case: 'postToolUse MCP 1 KB', p95: 1, ratio: b }, ...extra] });

test('within 20 % passes, above fails', () => {
  assert.equal(compare(report(2.39, 3.0), base, 0.2), 0);
  assert.equal(compare(report(2.41, 3.0), base, 0.2), 1);
  assert.equal(compare(report(1.0, 1.0), base, 0.2), 0, 'faster is fine');
});

test('a case missing from either side fails', () => {
  assert.equal(compare(report(2, 3, [{ agent: 'claude-code', case: 'new', p95: 1, ratio: 1 }]), base, 0.2), 1);
  assert.equal(compare({ results: [report(2, 3).results[0]] }, base, 0.2), 1);
});

test('a ratio that is not a positive number fails', () => {
  assert.equal(compare(report(NaN, 3.0), base, 0.2), 1);
  assert.equal(compare(report(null, 3.0), base, 0.2), 1);
  assert.equal(compare(report(0, 3.0), base, 0.2), 1);
  const badBase = { results: [{ ...base.results[0], ratio: null }, base.results[1]] };
  assert.equal(compare(report(2, 3.0), badBase, 0.2), 1);
});
