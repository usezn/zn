'use strict';

process.env.ZN_STATS = 'off';

// The check for an empty command substitution ($( ), $( true ), $(:) and the backtick forms) used two adjacent \s*
// around an optional word. A long run of spaces after "$(" then cost a quadratic number of steps: about 0.5 s at 20 KiB
// and about 11 s at the 100 KiB that a hook check reads. The pattern is linear now and keeps the same meaning.

const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../lib/hooks/policy');

const O = { cwd: '/home/u/proj', home: '/home/u', env: {} };
// Generous: the linear check takes a few milliseconds; the old pattern took seconds at this size.
const LIMIT_MS = 2000;

function timed(cmd) {
  const t0 = process.hrtime.bigint();
  const r = policy.bashDenial(cmd, O);
  return { ms: Number(process.hrtime.bigint() - t0) / 1e6, r };
}

test('a long run of spaces after an empty command substitution stays fast', () => {
  const pad = ' '.repeat(50000);
  const cases = [
    'echo $(' + pad,
    'echo `' + pad,
    'echo "$(' + pad,
    'echo $( true' + pad,
    'echo `: ' + pad,
  ];
  for (const cmd of cases) {
    assert.ok(cmd.length < 100 * 1024, 'under the hook size cap');
    const { ms, r } = timed(cmd);
    assert.ok(ms < LIMIT_MS, JSON.stringify(cmd.slice(0, 12)) + ' took ' + Math.round(ms) + ' ms');
    assert.ok(!r, JSON.stringify(cmd.slice(0, 12)) + ' is allowed as before');
  }
});

test('empty command substitutions keep their meaning', () => {
  assert.ok(!policy.bashDenial('echo $( )', O));
  assert.ok(!policy.bashDenial('echo $( true ) x', O));
  assert.ok(!policy.bashDenial('echo $(: ) x', O));
  assert.ok(!policy.bashDenial('echo $(true)', O));
  assert.ok(!policy.bashDenial('echo ` true ` x', O));
  assert.ok(!policy.bashDenial('echo `:` x', O));
  // An empty substitution that builds the path of a .env file is still refused.
  assert.ok(policy.bashDenial('rm -rf $( : )/.env', O));
});
