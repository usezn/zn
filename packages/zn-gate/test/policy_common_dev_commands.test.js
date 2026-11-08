'use strict';

process.env.ZN_STATS = 'off';

// Common project commands are allowed by the Bash policy: the package test script, the build script and the
// TypeScript compiler. These are static decisions only: no command is executed.

const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../lib/hooks/policy');

const OPTS = { cwd: '/work/proj' };

const COMMON_DEV_COMMANDS = ['npm test', 'npm run build', 'npx tsc', 'npx tsc --noEmit', 'npx tsc -p tsconfig.json'];

for (const c of COMMON_DEV_COMMANDS) {
  test('common dev command is allowed: ' + c, () => {
    assert.equal(policy.bashDenial(c, OPTS), null);
  });
}
