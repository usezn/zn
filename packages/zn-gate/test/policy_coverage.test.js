'use strict';

// Branches of the hook policy that the other tests do not reach: a secret given only as a shell variable,
// and a PowerShell command that already runs through `zn run`.

process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../lib/hooks/policy');

test('a secret given only as a shell variable is refused with the zn run hint', () => {
  const r = policy.wrapWithZnRun('GITHUB_TOKEN=__ZN_GITHUB_TOKEN__', 'zn run --');
  assert.equal(r.ok, false);
  assert.match(r.reason, /putting a secret in a shell variable would store only its placeholder/);
  assert.match(r.reason, /run --secrets NAME -- <command>/);
});

test('a PowerShell command that already runs through zn run is left as it is', () => {
  const opts = { nodePath: 'C:\\node\\node.exe', runJs: 'C:\\zn\\bin\\run.js', agent: 'claude-code' };
  for (const bin of ['zn', 'zn-gate', 'C:\\tools\\zn.exe']) {
    const r = policy.wrapPowerShell(bin + ' run -- gh api /user -H "Authorization: token __ZN_GITHUB_TOKEN__"', opts);
    assert.equal(r.ok, true, bin);
    assert.equal(r.wrapped, false, bin);
  }
});
