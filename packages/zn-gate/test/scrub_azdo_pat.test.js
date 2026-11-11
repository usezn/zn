'use strict';

// An Azure DevOps personal access token is passed to the `az devops` tooling in
// the AZURE_DEVOPS_EXT_PAT environment variable. The scrubber (the layer the
// agent hooks use for tool output and prompts) masks the value on such a line:
// a name made of words with the whole segment PAT counts as a secret name. The
// value is made up and built from pieces.

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

test('an AZURE_DEVOPS_EXT_PAT line is masked', () => {
  for (const text of [
    'AZURE_DEVOPS_EXT_PAT=' + VALUE,
    'export AZURE_DEVOPS_EXT_PAT=' + VALUE,
    'AZURE_DEVOPS_EXT_PAT="' + VALUE + '"',
    'echo start\nAZURE_DEVOPS_EXT_PAT=' + VALUE + '\necho end',
  ]) {
    assert.ok(covers(text, VALUE), 'not masked: ' + text.replace(VALUE, '<value>'));
  }
});

test('the same value on a variable with a token name is masked too', () => {
  assert.ok(covers('AZURE_DEVOPS_EXT_TOKEN=' + VALUE, VALUE));
});

test('other lines that name a PAT are masked', () => {
  for (const text of [
    'GH_PAT=' + VALUE,
    'PAT=' + VALUE,
    'ado_pat: ' + VALUE,
    'AZURE_DEVOPS_EXT_PAT=' + VALUE + ' az devops project list',
    '$env:AZURE_DEVOPS_EXT_PAT = "' + VALUE + '"',
  ]) {
    assert.ok(covers(text, VALUE), 'not masked: ' + text.replace(VALUE, '<value>'));
  }
});

test('names that only contain the letters PAT, and short or plain values, stay readable', () => {
  const other = '/usr/local/bin:/usr/bin:/bin:/opt/tools/bin';
  for (const text of [
    'PAT=yes',
    'AZURE_DEVOPS_EXT_PAT=short',
    'PAT=true-and-enabled',
    'PATH=' + other,
    'COMPAT=' + VALUE,
    'PATTERN=' + VALUE,
    'SPATIAL_INDEX=' + VALUE,
    'export PATIENT_NOTES=' + VALUE,
  ]) {
    assert.deepEqual(engine.scan(text), [], 'masked by mistake: ' + text.replace(VALUE, '<value>'));
  }
});
