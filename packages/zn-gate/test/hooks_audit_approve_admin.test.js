'use strict';

// `zn audit --approve` records what the person accepts of a project; an agent that rewrote the configuration must not be able to run it.

process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../lib/hooks/policy');

test('an agent may not run zn audit --approve, in any spelling', () => {
  for (const c of ['zn audit --approve', 'npx -y zn-gate audit --approve', 'npx -y zn-gate audit . --approve', 'zn-gate audit --approve --format json', 'zn-gate audit ./some/dir --format json --approve',
    'node node_modules/zn-gate/bin/cli.js audit --approve', 'zn-gate.cmd audit --approve', 'cd app && zn audit --approve', 'echo ok; zn audit --approve', '"zn" audit --approve',
    'zn-gate@1.14.1 audit --approve']) {
    assert.match(policy.bashDenial(c) || '', /zn audit --approve/, c);
  }
});

test('zn audit itself, and other uses of the word approve, are allowed', () => {
  for (const c of ['zn audit', 'zn audit --format json', 'npx -y zn-gate audit ./some-repo', 'zn audit --fail-on high', 'echo audit --approve', 'git commit -m "audit --approve"',
    'npm audit', 'npm audit --approve-all', 'zn-gate audit . --output report.sarif']) {
    assert.equal(policy.bashDenial(c), null, c);
  }
});
