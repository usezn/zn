'use strict';

// Python linters and formatters (ruff, black, mypy) must stay allowed by the Bash hook policy and by the
// destructive-command check. Uninstalling every installed package at once (pip freeze piped into pip uninstall)
// has no rule yet, so those cases stay todo until the product decides whether to block them.
// The command strings are only evaluated by the policy functions, never run.

process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');

const policy = require('../lib/hooks/policy');
const { checkCommand } = require('../lib/destructive');

const LINTERS = ['ruff check .', 'ruff format .', 'black .', 'mypy src'];

test('python linters and formatters are allowed by the bash policy and the destructive check', () => {
  for (const cmd of LINTERS) {
    assert.equal(policy.bashDenial(cmd), null, 'bashDenial blocked: ' + cmd);
    assert.equal(checkCommand(cmd).verdict, 'allow', 'checkCommand blocked: ' + cmd);
  }
});

const UNINSTALL_EVERYTHING = [
  'pip freeze | xargs pip uninstall -y',
  'pip uninstall -y -r <(pip freeze)',
  'pip freeze | xargs -n1 pip uninstall -y',
];

for (const cmd of UNINSTALL_EVERYTHING) {
  test('uninstalling every pip package is blocked: ' + cmd, {
    todo: 'no rule for uninstalling every package yet (pending product decision)',
  }, () => {
    assert.notEqual(policy.bashDenial(cmd), null, 'expected a denial for: ' + cmd);
  });
}
