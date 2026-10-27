'use strict';
// zn team join asks two questions in a row (the organization lookup, then the join), so the
// vault client waits longer for teamJoin than for the other confirmed operations.
const test = require('node:test');
const assert = require('node:assert/strict');
const { callTimeoutMs } = require('../lib/vault/client');

test('teamJoin waits up to 300 s for its two confirmations', () => {
  assert.equal(callTimeoutMs('teamJoin'), 300000);
});

test('other confirmed operations keep the 150 s wait', () => {
  for (const op of ['recordApproval', 'teamLeave', 'confirmOrgOpening']) {
    assert.equal(callTimeoutMs(op), 150000, op);
  }
});
