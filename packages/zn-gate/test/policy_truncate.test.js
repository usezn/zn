'use strict';

// `truncate -s 0` in the Bash policy. The home folder and the project are temporary folders; no command is executed.
// The policy reads the command statically (policy.bashDenial, the default hook policy). A shell startup file in the
// home folder is not protected against truncate yet: those cases are marked as known gaps (todo), not as allowed.

process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const policy = require('../lib/hooks/policy');
const { tempDir } = require('./helpers/tmp');

const GAP = 'known gap: truncate of a shell startup file in the home folder is not denied yet';

function setup(t) {
  const home = tempDir(t, 'zn-trunc-home-');
  const cwd = tempDir(t, 'zn-trunc-cwd-');
  fs.writeFileSync(path.join(home, '.bashrc'), 'export EXAMPLE=1\n');
  fs.mkdirSync(path.join(cwd, 'logs'));
  fs.writeFileSync(path.join(cwd, 'logs', 'app.log'), 'example line\n');
  return { home, cwd, opts: { home, cwd, env: { HOME: home, USERPROFILE: home } } };
}

test('truncate -s 0 on a project log file is allowed', (t) => {
  const { opts } = setup(t);
  assert.equal(policy.bashDenial('truncate -s 0 logs/app.log', opts), null);
  assert.equal(policy.bashDenial('truncate -s 0 ./logs/app.log', opts), null);
});

test('truncate -s 0 on a home dotfile is blocked: ~/.bashrc', { todo: GAP }, (t) => {
  const { home, opts } = setup(t);
  assert.notEqual(policy.bashDenial('truncate -s 0 ' + path.join(home, '.bashrc'), opts), null);
});

test('truncate -s 0 on a home dotfile is blocked: ~/.bashrc written with ~', { todo: GAP }, (t) => {
  const { opts } = setup(t);
  assert.notEqual(policy.bashDenial('truncate -s 0 ~/.bashrc', opts), null);
});
