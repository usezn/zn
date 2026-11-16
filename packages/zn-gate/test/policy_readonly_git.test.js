'use strict';

process.env.ZN_STATS = 'off';

// Read-only git commands are allowed by the Bash policy. These are static
// decisions only: no command is executed.

const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../lib/hooks/policy');

const OPTS = { cwd: '/work/proj' };

const READ_ONLY_GIT = ['git diff', 'git show HEAD', 'git branch', 'git branch -a', 'git branch --list'];

for (const c of READ_ONLY_GIT) {
  test('read-only git is allowed: ' + c, () => {
    assert.equal(policy.bashDenial(c, OPTS), null);
  });
}
