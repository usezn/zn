'use strict';

// actionFor in lib/reach/history.js: the closed advice text for one secret type.
// The type names below are made up for the test, so the labels table is not touched.

const test = require('node:test');
const assert = require('node:assert/strict');
const { _internal } = require('../lib/reach/history');

const { actionFor } = _internal;
const CLOSING = 'then delete this session file if you do not need it.';

test('actionFor: a type with a label uses its name and where to rotate it', () => {
  // GITHUB_TOKEN is a labelled type: the text comes from the table, not from the type name.
  assert.equal(
    actionFor('GITHUB_TOKEN'),
    'Rotate this GitHub token in your GitHub settings, ' + CLOSING
  );
});

test('actionFor: a type without a label is lower-cased with underscores turned into spaces', () => {
  assert.equal(
    actionFor('FAKE_SERVICE_API_KEY'),
    'Rotate this fake service api key at the service it belongs to, ' + CLOSING
  );
  assert.equal(
    actionFor('EXAMPLETOKEN'),
    'Rotate this exampletoken at the service it belongs to, ' + CLOSING
  );
});

test('actionFor: every underscore is replaced, including a run of them', () => {
  assert.equal(
    actionFor('FAKE__TYPE_'),
    'Rotate this fake  type  at the service it belongs to, ' + CLOSING
  );
});

test('actionFor: the closing step is the same for labelled and unlabelled types', () => {
  for (const type of ['AWS_KEY', 'PRIVATE_KEY', 'FAKE_TYPE_ONE', 'FAKE2']) {
    const text = actionFor(type);
    assert.ok(text.endsWith(', ' + CLOSING), type);
    assert.ok(text.startsWith('Rotate this '), type);
  }
});

test('actionFor: a name that only looks like a table key is not a label', () => {
  // Lookup is exact: a lower-case name is not the labelled type.
  assert.equal(
    actionFor('aws_key'),
    'Rotate this aws key at the service it belongs to, ' + CLOSING
  );
});
