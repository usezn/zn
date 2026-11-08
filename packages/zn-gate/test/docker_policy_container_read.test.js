'use strict';

// Container read commands and the destructive-command policy. `docker ps` and `docker logs web` are read-only and pass
// both the hook policy and the destructive check. `docker system prune -a` is not a shape of any destructive rule
// (docs/destructive-commands.md lists none for docker, and the shared corpus marks `docker system prune -f` as benign),
// so the policy allows it today. The test that expects a block is skipped until someone decides whether prune belongs
// in the policy. Values are fake.

process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');

const policy = require('../lib/hooks/policy');
const { checkCommand } = require('../lib/destructive');

const OPTS = { home: '/home/fake-user', cwd: '/home/fake-user/project' };

for (const cmd of ['docker ps', 'docker logs web']) {
  test(`read-only container command passes both checks: ${cmd}`, () => {
    assert.equal(checkCommand(cmd).verdict, 'allow');
    assert.equal(policy.bashDenial(cmd, OPTS), null);
  });
}

test('docker system prune -a is blocked by the destructive policy', {
  skip: 'open: no destructive rule covers docker prune; checkCommand allows it (rule none) and docs/destructive-commands.md lists no prune shape. Needs a product decision.',
}, () => {
  const res = checkCommand('docker system prune -a');
  assert.equal(res.verdict, 'block');
});
