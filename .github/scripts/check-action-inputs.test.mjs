// Tests of check-action-inputs.mjs. Run: node --test .github/scripts/check-action-inputs.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkText } from './check-action-inputs.mjs';

test('inputs with a description pass', () => {
  const text = "name: x\ninputs:\n  version:\n    description: 'The version.'\n    required: false\n  mode:\n    description: \"scan or audit.\"\n    default: scan\n";
  assert.deepEqual(checkText(text), { inputs: 2, problems: [] });
});

test('a missing description is named', () => {
  const text = 'inputs:\n  version:\n    required: false\n  mode:\n    description: ok\n';
  assert.deepEqual(checkText(text).problems, [{ input: 'version', reason: 'no description' }]);
});

test('an empty description is named', () => {
  const text = "inputs:\n  a:\n    description: ''\n  b:\n    description:\n    required: false\n  c:\n    description: \"\"\n";
  assert.deepEqual(checkText(text).problems.map((p) => p.input), ['a', 'b', 'c']);
});

test('a block scalar description counts when it has text', () => {
  const folded = 'inputs:\n  a:\n    description: >-\n      Some text\n      over two lines.\n    required: false\n';
  assert.deepEqual(checkText(folded).problems, []);
  const empty = 'inputs:\n  a:\n    description: |\n    required: false\n';
  assert.deepEqual(checkText(empty).problems.map((p) => p.input), ['a']);
});

test('a description on the following line counts', () => {
  const text = 'inputs:\n  a:\n    description:\n      Text on the next line.\n';
  assert.deepEqual(checkText(text).problems, []);
});

test('CRLF line endings are read the same way', () => {
  const text = 'inputs:\r\n  a:\r\n    description: ok\r\n  b:\r\n    required: false\r\n';
  assert.deepEqual(checkText(text).problems, [{ input: 'b', reason: 'no description' }]);
});

test('a description of an output or another section does not count for an input', () => {
  const text = 'inputs:\n  a:\n    required: false\noutputs:\n  b:\n    description: ok\n';
  assert.deepEqual(checkText(text).problems, [{ input: 'a', reason: 'no description' }]);
});

test('an action with inputs: but no readable input fails', () => {
  const text = 'inputs:\n    a:\n        description: ok\n';
  assert.equal(checkText(text).problems[0].input, '(file)');
});

test('an action without inputs has nothing to check', () => {
  assert.deepEqual(checkText('name: x\nruns:\n  using: node20\n'), { inputs: 0, problems: [] });
});
