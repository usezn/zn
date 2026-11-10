'use strict';

// git reset: which forms the destructive-command policy refuses and which stay allowed.
// docs/destructive-commands.md lists no git reset shape (git clean is named as not covered), so the documented
// refusals are none. The forms below that must stay allowed are pinned; a --hard form against a remote ref is a
// known gap (todo), not a rule that exists today.

process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const { checkCommand } = require('../lib/destructive');
const policy = require('../lib/hooks/policy');

function opts(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-reset-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { cwd: dir, home: dir };
}

const ALLOWED = [
  'git reset --soft HEAD~1',
  'git reset --mixed HEAD~1',
  'git reset HEAD~1',
  'git reset src/index.js',
  'git reset -- src/index.js',
  'git reset HEAD -- src/index.js',
  'git reset --hard HEAD~1',
  'git reset --hard HEAD',
];

for (const cmd of ALLOWED) {
  test('git reset form stays allowed: ' + cmd, (t) => {
    assert.equal(checkCommand(cmd).verdict, 'allow');
    assert.equal(policy.bashDenial(cmd, opts(t)), null);
  });
}

// Refused by nothing today: docs do not list it and no rule matches. Kept visible as a gap.
const GAP = [
  'git reset --hard origin/main',
  'git reset --hard origin/next',
  'git reset --hard -f origin/main',
  'git reset --hard --force origin/main',
  'git -C repo reset --hard origin/main',
];
for (const cmd of GAP) {
  test('git reset --hard against a remote ref should be refused: ' + cmd, {
    todo: 'known gap: no rule refuses git reset --hard today (docs/destructive-commands.md lists none); needs a product decision',
  }, (t) => {
    assert.equal(checkCommand(cmd).verdict, 'block');
    assert.notEqual(policy.bashDenial(cmd, opts(t)), null);
  });
}
