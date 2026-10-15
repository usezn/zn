'use strict';
// The hook policy's patterns run on commands an agent writes: they must take
// linear time on long or repetitive input.

const test = require('node:test');
const assert = require('node:assert');
const policy = require('../lib/hooks/policy');

test('the admin-command check is fast on a long run of flags', () => {
  const flags = Array.from({ length: 40 }, () => '--a').join(' ');
  for (const cmd of ['zn stats ' + flags + ' x', 'zn stats ' + '--days 7 '.repeat(2000) + 'share', 'zn-gate stats ' + flags + ' share of', 'zn stats ' + '-a '.repeat(5000) + 'share']) {
    const start = process.hrtime.bigint();
    policy.adminCommand(cmd);
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    assert.ok(ms < 500, cmd.slice(0, 40) + ' took ' + ms + ' ms');
  }
});

test('the stats share check still matches with flags', () => {
  assert.strictEqual(policy.adminCommand('zn stats --json share on'), 'stats --json share on');
  assert.strictEqual(policy.adminCommand('zn-gate stats -v share on'), 'stats -v share on');
  assert.strictEqual(policy.adminCommand('zn stats share on'), 'stats share on');
  assert.strictEqual(policy.adminCommand('zn stats --days 7 share on'), 'stats --days 7 share on');
  assert.strictEqual(policy.adminCommand('zn stats --json'), null);
});
