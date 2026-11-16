// Tests of check-action-inputs-documented.mjs. Run: node --test .github/scripts/check-action-inputs-documented.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { actionInputs, undocumented } from './check-action-inputs-documented.mjs';

const action = `name: 'Example'
description: 'Example action'
# A comment between the keys
inputs:
  version:
    description: 'Version to install.'
    required: false
    default: '1.0.0'
  # comment inside the inputs block
  fail-on-threat:
    description: 'Whether to fail.'
    required: false
    default: 'true'
outputs:
  result:
    description: 'Not an input.'
runs:
  using: 'composite'
  steps:
    - run: echo hi
`;

test('the input names are the keys two spaces under inputs:', () => {
  assert.deepEqual(actionInputs(action), ['version', 'fail-on-threat']);
});

test('keys of other top-level blocks are not inputs', () => {
  assert.equal(actionInputs(action).includes('result'), false);
  assert.equal(actionInputs(action).includes('using'), false);
});

test('an input is named only when its name is in backticks', () => {
  const doc = 'The `version` input. fail-on-threat is in plain text. Use `fail-on-threat: true`.';
  assert.deepEqual(undocumented(['version', 'fail-on-threat'], doc), ['fail-on-threat']);
});

test('a name that is a prefix of another does not count as documented', () => {
  assert.deepEqual(undocumented(['fail-on'], 'The `fail-on-threat` input.'), ['fail-on']);
});

test('every input named in backticks passes', () => {
  assert.deepEqual(undocumented(['version', 'fail-on-threat'], '| `version` | x |\n| `fail-on-threat` | y |'), []);
});
