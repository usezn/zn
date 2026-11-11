'use strict';

process.env.ZN_STATS = 'off';

// docker build and docker run without privileged flags are allowed by the Bash policy.
// These are static decisions only: no command is executed.

const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../lib/hooks/policy');

const OPTS = { cwd: '/work/proj' };

const DOCKER_ALLOWED = ['docker build -t app .', 'docker run --rm app'];

for (const c of DOCKER_ALLOWED) {
  test('docker build and run without privileged flags are allowed: ' + c, () => {
    assert.equal(policy.bashDenial(c, OPTS), null);
  });
}
