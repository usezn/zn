'use strict';
/* Checks how pinsError, teamJoinFailed and agentNote place their input in the sentence. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { pinsError, teamJoinFailed, agentNote } = require('../lib/messages');

test('pinsError puts the reason in the sentence as given', () => {
  assert.equal(pinsError('no server named "example"'),
    'zn-gate pins: no server named "example". Run `zn-gate pins` to see the servers and their full keys.');
  assert.ok(pinsError('Some Reason').includes(': Some Reason. '));
});

test('teamJoinFailed puts the reason in brackets as given', () => {
  assert.equal(teamJoinFailed('token expired'), 'join failed (token expired). This machine was not connected.');
  assert.ok(teamJoinFailed('Mixed CASE').includes('(Mixed CASE)'));
});

test('agentNote changes only for a name that starts with "started from"', () => {
  assert.equal(agentNote('started from example'),
    ' (zn found it was started from example). If you are not using an AI agent, open a new terminal window and try again.');
  assert.equal(agentNote('EXAMPLE_AGENT'), ' (detected EXAMPLE_AGENT).');
  assert.equal(agentNote('was started from example'), ' (detected was started from example).');
  assert.equal(agentNote('Started from example'), ' (detected Started from example).');
});

test('none of the three ends with a doubled full stop', () => {
  const texts = [
    pinsError('a reason without a stop'),
    teamJoinFailed('a reason without a stop'),
    agentNote('EXAMPLE_AGENT'),
    agentNote('started from example'),
  ];
  for (const t of texts) {
    assert.ok(t.endsWith('.'), t);
    assert.ok(!t.endsWith('..'), t);
  }
});
