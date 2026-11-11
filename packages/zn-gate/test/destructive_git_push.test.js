'use strict';

// Git push commands that would rewrite or delete the default branch on the remote. The policy has no git push
// rule yet: these are allowed today. The desired block is marked todo until the product decision is made.
// The commands are only evaluated by checkCommand, never executed.

const test = require('node:test');
const assert = require('node:assert/strict');

const { checkCommand } = require('../lib/destructive');

const TODO = 'no git push rule yet (pending product decision)';

for (const cmd of ['git push --mirror origin', 'git push origin --delete main', 'git push origin :main']) {
  test('git push: desired block for ' + cmd, { todo: TODO }, () => {
    assert.equal(checkCommand(cmd).verdict, 'block');
  });
}

test('git push: an ordinary push to a feature branch is allowed', () => {
  assert.equal(checkCommand('git push origin feature-x').verdict, 'allow');
});
