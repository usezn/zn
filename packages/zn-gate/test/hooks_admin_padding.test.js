'use strict';

// The admin commands only the user may run are recognised wherever the flag sits in the command, however long the
// arguments in front of it are. Command strings are only judged here, never run.

process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../lib/hooks/policy');

const ADMIN = [
  ['zn-gate audit', '--approve', /zn blocked this: `zn audit --approve`/],
  ['zn audit', '--approve', /zn blocked this: `zn audit --approve`/],
  ['npx -y zn-gate@1.14.1 audit', '--approve', /zn blocked this: `zn audit --approve`/],
  ['zn-gate evidence', '--accept', /zn blocked this: `zn-gate evidence --accept`/],
  ['zn evidence', '--accept', /zn blocked this: `zn-gate evidence --accept`/],
  ['./node_modules/.bin/zn-gate evidence', '--accept', /zn blocked this: `zn-gate evidence --accept`/],
  ['node node_modules/zn-gate/bin/cli.js evidence', '--accept', /zn blocked this: `zn-gate evidence --accept`/],
  ['zn-gate.cmd evidence', '--accept', /zn blocked this: `zn-gate evidence --accept`/],
  ['zn vault verify', '--acknowledge', /zn blocked this: `zn vault verify --acknowledge`/],
  ['zn-gate vault verify', '--acknowledge', /zn blocked this: `zn vault verify --acknowledge`/],
  ['npx -y zn-gate vault verify', '--acknowledge', /zn blocked this: `zn vault verify --acknowledge`/],
];
const SIZES = [600, 5000, 50000];

test('an admin flag after a long run of arguments is still denied', () => {
  for (const [head, flag, want] of ADMIN) {
    for (const n of SIZES) {
      const pad = 'a'.repeat(n);
      for (const c of [`${head} --out ${pad} ${flag}`, `${head} ${pad} ${flag}`, `cd app && ${head} ${pad} ${flag}`, `echo ok; ${head} ${pad}\t${flag}=1`]) {
        assert.match(policy.bashDenial(c) || '', want, `${head} padded to ${n}`);
      }
    }
  }
});

test('padding made of many short arguments is denied too', () => {
  const pad = Array.from({ length: 4000 }, (_, i) => 'f' + i).join(' ');
  for (const [head, flag, want] of ADMIN) assert.match(policy.bashDenial(`${head} ${pad} ${flag}`) || '', want, head);
});

test('the flag in another command of the line does not count, however long the first one is', () => {
  for (const [head, flag] of ADMIN) {
    for (const n of SIZES) {
      const pad = 'a'.repeat(n);
      for (const sep of [';', '&&', '||', '|', '\n']) {
        assert.equal(policy.bashDenial(`${head} ${pad} ${sep} echo ${flag}`), null, `${head} ${n} ${JSON.stringify(sep)}`);
      }
    }
  }
});

test('long harmless zn commands stay allowed', () => {
  for (const n of SIZES) {
    const pad = 'a'.repeat(n);
    for (const c of ['zn-gate audit', 'zn-gate evidence --export --out', 'zn-gate evidence --verify', 'zn vault verify --json', 'zn vault status', 'zn-gate evidence']) {
      assert.equal(policy.bashDenial(`${c} ${pad}`), null, `${c} ${n}`);
      assert.equal(policy.bashDenial(`${c} ${pad} --accepted`), null, `${c} ${n} --accepted`);
      assert.equal(policy.bashDenial(`${c} ${pad} --acknowledged-by-nobody`), null, `${c} ${n} --acknowledged-by-nobody`);
      assert.equal(policy.bashDenial(`${c} ${pad} --approved`), null, `${c} ${n} --approved`);
    }
    assert.equal(policy.bashDenial(`echo evidence ${pad} --accept`), null);
    assert.equal(policy.bashDenial(`git commit -m "audit ${pad} --approve"`), null);
  }
});

test('an admin command in a later part of a line is found after a harmless one with the same word', () => {
  assert.match(policy.bashDenial('zn-gate evidence --verify; zn-gate evidence --accept') || '', /evidence --accept/);
  assert.match(policy.bashDenial('zn audit; zn evidence --accept') || '', /evidence --accept/);
  assert.match(policy.bashDenial('zn audit zn evidence --accept') || '', /evidence --accept/);
  assert.match(policy.bashDenial('zn evidence --export zn unlock') || '', /unlock/);
});

test('a command over the scan limit is refused, so padding cannot skip the admin check', () => {
  const c = 'zn-gate evidence ' + 'a'.repeat(policy.SHELL_SCAN_CAP) + ' --accept';
  assert.ok(policy.bashDenial(c), 'over the limit');
});

test('judging a long command is fast', () => {
  const big = 'zn-gate evidence ' + 'a'.repeat(1024 * 1024) + ' --accept';
  const t0 = process.hrtime.bigint();
  assert.ok(policy.bashDenial(big));
  assert.ok(Number(process.hrtime.bigint() - t0) / 1e6 < 200, '1 MB under 200 ms');
  // Just under the scan limit, many admin words and no flag: one pass, not one per word.
  const dense = 'zn-gate evidence '.repeat(Math.floor((policy.SHELL_SCAN_CAP - 10) / 17));
  const t1 = process.hrtime.bigint();
  assert.equal(policy.bashDenial(dense), null);
  assert.ok(Number(process.hrtime.bigint() - t1) / 1e6 < 200, 'dense line under 200 ms');
});

test('the policy rules version moved with the padding fix', () => {
  assert.ok(policy.POLICY_RULES_VERSION >= '2026-11-11.3');
});
