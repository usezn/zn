'use strict';

// `zn-gate evidence --accept` and `zn vault verify --acknowledge` re-anchor or accept integrity state; only the user may run them.

process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../lib/hooks/policy');

test('an agent may not run evidence --accept, in any spelling', () => {
  for (const c of ['zn-gate evidence --accept', 'zn evidence --accept', 'npx -y zn-gate evidence --accept', 'npx -y zn-gate@1.14.1 evidence --accept', 'zn-gate evidence --verify --accept',
    'zn-gate evidence --accept --verify', 'zn-gate evidence --out report.jsonl --accept', 'zn-gate evidence --accept=true', 'node node_modules/zn-gate/bin/cli.js evidence --accept',
    './node_modules/.bin/zn-gate evidence --accept', 'zn-gate.cmd evidence --accept', 'cd app && zn-gate evidence --accept', 'echo ok; zn evidence --accept', '"zn-gate" evidence --accept',
    'zn-gate evidence "--accept"', "zn-gate evidence --acc''ept", 'zn-gate "evidence" --accept', 'zn-gate evidence --verify \\\n--accept']) {
    assert.match(policy.bashDenial(c) || '', /zn blocked this: `zn-gate evidence --accept`/, c);
  }
});

test('an agent may not run vault verify --acknowledge, in any spelling', () => {
  for (const c of ['zn vault verify --acknowledge', 'zn-gate vault verify --acknowledge', 'npx -y zn-gate vault verify --acknowledge', 'zn-gate@1.14.1 vault verify --acknowledge',
    'zn vault verify --acknowledge=1', 'zn vault verify  --acknowledge', 'node node_modules/zn-gate/bin/cli.js vault verify --acknowledge', 'zn.cmd vault verify --acknowledge',
    'cd app && zn vault verify --acknowledge', 'echo ok; zn vault verify --acknowledge', 'zn vault verify "--acknowledge"', "zn vault verify --acknow''ledge", 'zn "vault" verify --acknowledge']) {
    assert.match(policy.bashDenial(c) || '', /zn blocked this: `zn vault verify --acknowledge`/, c);
  }
});

test('reading the evidence log and checking the audit log stay allowed', () => {
  for (const c of ['zn-gate evidence', 'zn-gate evidence --verify', 'zn-gate evidence --export', 'zn-gate evidence --export --out report.jsonl', 'npx -y zn-gate evidence --verify',
    'zn-gate evidence --accepted', 'zn-gate evidence --accept-all-things', 'zn vault verify', 'zn vault status', 'zn vault log --since 1h', 'zn vault verify --json',
    'zn vault verify --acknowledged-by-nobody', 'echo evidence --accept', 'git commit -m "evidence --accept"', 'grep acknowledge README.md']) {
    assert.equal(policy.bashDenial(c), null, c);
  }
});

test('the policy rules version moved with the admin list', () => {
  assert.ok(policy.POLICY_RULES_VERSION >= '2026-11-11.2');
});
