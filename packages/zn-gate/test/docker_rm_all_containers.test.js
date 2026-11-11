'use strict';
// Removing every container (or pruning them) through a command substitution or a prune is not blocked yet:
// the destructive-command policy has no docker rule. The blocks are todo until that product decision is made.
// The commands are only evaluated by the policy, never run.

const test = require('node:test');
const assert = require('node:assert/strict');
const { checkCommand } = require('../lib/destructive');

const TODO = 'no docker rule yet (pending product decision)';

const BLOCKED_LATER = [
  'docker rm -f $(docker ps -aq)',
  'docker rm -f `docker ps -aq`',
  'docker container prune -f',
  'docker system prune -af --volumes',
];

for (const cmd of BLOCKED_LATER) {
  test('destructive policy blocks ' + JSON.stringify(cmd), { todo: TODO }, () => {
    assert.equal(checkCommand(cmd).verdict, 'block');
  });
}

test('destructive policy allows listing containers', () => {
  const res = checkCommand('docker ps -a');
  assert.equal(res.verdict, 'allow');
  assert.equal(res.rule, 'none');
});

test('destructive policy allows removing one named container', () => {
  const res = checkCommand('docker rm my-test-container');
  assert.equal(res.verdict, 'allow');
  assert.equal(res.rule, 'none');
});
