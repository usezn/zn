'use strict';

// An Azure DevOps personal access token is passed to the `az devops` tooling in
// the AZURE_DEVOPS_EXT_PAT environment variable. The scrubber (the layer the
// agent hooks use for tool output and prompts) should mask the value on such a
// line. The value is made up and built from pieces. The first test records a
// gap: the scrubber does not mask this variable today, so it is marked todo
// and turns into a normal test when a rule covers it.

const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../lib/scrub/engine');

// 52 characters, mixed case and digits, not a real token.
const VALUE = 'Zx9kQ2mN8pL4' + 'rT6vW1yHc5J0' + 'aB3dF7gH9jK2' + 'mN4pQ6rS8tU1' + 'vW3y';

const covers = (text, value) => {
  const at = text.indexOf(value);
  return engine.scan(text).some((d) => d.start <= at && d.end >= at + value.length);
};

test('the fake value has the length of an Azure DevOps token', () => {
  assert.equal(VALUE.length, 52);
});

test('an AZURE_DEVOPS_EXT_PAT line is masked', { todo: 'gap: the scrubber does not mask AZURE_DEVOPS_EXT_PAT yet' }, () => {
  for (const text of [
    'AZURE_DEVOPS_EXT_PAT=' + VALUE,
    'export AZURE_DEVOPS_EXT_PAT=' + VALUE,
    'AZURE_DEVOPS_EXT_PAT="' + VALUE + '"',
    'echo start\nAZURE_DEVOPS_EXT_PAT=' + VALUE + '\necho end',
  ]) {
    assert.ok(covers(text, VALUE), 'not masked: ' + text.replace(VALUE, '<value>'));
  }
});

test('the same value on a variable with a token name is masked, so the shape is not the cause', () => {
  assert.ok(covers('AZURE_DEVOPS_EXT_TOKEN=' + VALUE, VALUE));
});
