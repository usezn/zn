'use strict';

// Hook policy on infrastructure and git commands that the destructive-command rules do not cover.
// The allow cases are pinned. The block cases are strict expected failures: the hook policy allows these
// commands today, and docs/destructive-commands.md lists six rules, none of them for kubectl, terraform or
// git push --force. A strict expected failure passes while the command is allowed and fails once a rule
// blocks it, which is the moment to remove the wrapper.

process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');

const policy = require('../lib/hooks/policy');
const { tempDir } = require('./helpers/tmp');

function options(t) {
  const dir = tempDir(t, 'zn-infra-policy-');
  return { cwd: dir, home: dir, env: {} };
}

// Runs the assertion and passes only if it fails. Used for the gaps the policy has today.
function expectedFailure(name, reason, body) {
  test(`${name} (expected failure: ${reason})`, (t) => {
    let failed = false;
    try {
      body(options(t));
    } catch {
      failed = true;
    }
    assert.ok(failed, 'the command is now blocked: remove the expected-failure wrapper');
  });
}

const GAP = 'the hook policy allows it today, no rule covers it';

for (const cmd of ['kubectl get pods', 'terraform plan', 'git push origin feature/x']) {
  test(`hook policy allows ${cmd}`, (t) => {
    assert.ok(!policy.bashDenial(cmd, options(t)), 'denied');
  });
}

expectedFailure('hook policy blocks kubectl delete namespace prod', GAP, (o) => {
  assert.ok(policy.bashDenial('kubectl delete namespace prod', o), 'allowed');
});

expectedFailure('hook policy blocks terraform destroy -auto-approve', GAP, (o) => {
  assert.ok(policy.bashDenial('terraform destroy -auto-approve', o), 'allowed');
});

expectedFailure('hook policy blocks git push --force origin main', GAP, (o) => {
  assert.ok(policy.bashDenial('git push --force origin main', o), 'allowed');
});
