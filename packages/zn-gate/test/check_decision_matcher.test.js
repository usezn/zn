'use strict';

// zn-gate check: how a hook's answer is read (decisionOf) and which tools a hook matcher covers (matcherCovers).

process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const { decisionOf, matcherCovers } = require('../lib/check')._internal;

test('decisionOf: exit status 2 is deny whatever stdout says', () => {
  assert.equal(decisionOf('', 2), 'deny');
  assert.equal(decisionOf('{"decision":"allow"}', 2), 'deny');
});

test('decisionOf: deny forms in stdout', () => {
  for (const out of [
    '{"hookSpecificOutput":{"permissionDecision":"deny"}}',
    '{"decision":"deny"}',
    '{"decision": "block"}',
    '{"permission":"deny"}',
    '{"continue": false}',
  ]) assert.equal(decisionOf(out, 0), 'deny', out);
});

test('decisionOf: anything else is allow', () => {
  for (const out of ['', undefined, '{}', '{"decision":"allow"}', '{"continue":true}', 'not json'])
    assert.equal(decisionOf(out, 0), 'allow', String(out));
  assert.equal(decisionOf('', 1), 'allow');
});

test('matcherCovers: missing or wildcard matcher covers every tool', () => {
  for (const m of [undefined, null, '', '*']) {
    assert.equal(matcherCovers(m, 'Bash'), true);
    assert.equal(matcherCovers(m, 'Read'), true);
  }
});

test('matcherCovers: alternation matches whole names only', () => {
  assert.equal(matcherCovers('Bash|Edit', 'Bash'), true);
  assert.equal(matcherCovers('Bash|Edit', 'Edit'), true);
  assert.equal(matcherCovers('Bash|Edit', 'Bashx'), false);
  assert.equal(matcherCovers('Bash|Edit', 'Read'), false);
});

test('matcherCovers: an invalid pattern falls back to exact names split on |', () => {
  assert.equal(matcherCovers('(', '('), true);
  assert.equal(matcherCovers('(', 'Bash'), false);
  assert.equal(matcherCovers('(|Bash', 'Bash'), true);
  assert.equal(matcherCovers('(|Bash', 'Bashx'), false);
});
