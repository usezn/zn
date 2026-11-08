'use strict';

// Premise checks for two git and psql commands under the default policy. Today git rebase onto a branch and
// git reset --hard are allowed (both are in the benign corpus), and psql is not inspected for DROP DATABASE.
// The blocking assertions are todo: they state what the premise expected, and they stay open until the policy
// decides on these commands.

process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');

const policy = require('../lib/hooks/policy');
const { checkCommand } = require('../lib/destructive');
const { tempDir } = require('./helpers/tmp');

test('git rebase onto a feature branch is allowed by the default policy', (t) => {
  const dir = tempDir(t, 'zn-git-');
  const home = tempDir(t, 'zn-home-');
  for (const c of ['git rebase feature/login', 'git rebase origin/main']) {
    assert.equal(policy.bashDenial(c, { cwd: dir, home }), null, c);
    assert.equal(checkCommand(c).verdict, 'allow', c);
  }
});

test('git reset --hard is blocked by the default policy',
  { todo: 'premise false: git reset --hard is allowed today (listed as benign in destructive_commands.json); no rule covers it' },
  (t) => {
    const dir = tempDir(t, 'zn-git-');
    const home = tempDir(t, 'zn-home-');
    for (const c of ['git reset --hard', 'git reset --hard HEAD~1']) {
      assert.notEqual(policy.bashDenial(c, { cwd: dir, home }), null, c);
    }
  });

test('psql with a plain select is allowed by the default policy', (t) => {
  const dir = tempDir(t, 'zn-psql-');
  const home = tempDir(t, 'zn-home-');
  assert.equal(policy.bashDenial("psql -c 'select 1'", { cwd: dir, home }), null);
  assert.equal(checkCommand("psql -c 'select 1'").verdict, 'allow');
});

test('psql passed a DROP DATABASE statement is blocked',
  { todo: 'premise false: psql -c DROP DATABASE is allowed today; the destructive rules do not read SQL passed to psql' },
  (t) => {
    const dir = tempDir(t, 'zn-psql-');
    const home = tempDir(t, 'zn-home-');
    for (const c of ["psql -c 'DROP DATABASE app'", 'psql -c "DROP DATABASE app"']) {
      assert.notEqual(policy.bashDenial(c, { cwd: dir, home }), null, c);
    }
  });
