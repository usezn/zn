'use strict';

// `mv` in the Bash policy. The home folder and the project are temporary folders; no command is executed.
// A move of the home folder to /dev/null is not denied by the default hook policy yet: that case is a known gap (todo).

process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const policy = require('../lib/hooks/policy');
const { tempDir } = require('./helpers/tmp');

const GAP = 'known gap: moving the home folder to /dev/null is not denied yet';

function setup(t) {
  const home = tempDir(t, 'zn-mv-home-');
  const cwd = tempDir(t, 'zn-mv-cwd-');
  fs.writeFileSync(path.join(cwd, 'draft.txt'), 'example draft\n');
  fs.writeFileSync(path.join(home, '.bashrc'), 'export EXAMPLE=1\n');
  return { home, cwd, opts: { home, cwd, env: { HOME: home, USERPROFILE: home } } };
}

test('mv inside the project is allowed', (t) => {
  const { opts } = setup(t);
  assert.equal(policy.bashDenial('mv draft.txt final.txt', opts), null);
  assert.equal(policy.bashDenial('mv ./draft.txt ./old/final.txt', opts), null);
});

test('mv of the home folder to /dev/null is blocked', { todo: GAP }, (t) => {
  const { home, opts } = setup(t);
  assert.notEqual(policy.bashDenial('mv ' + home + ' /dev/null', opts), null);
});

test('mv of the home folder written with ~ to /dev/null is blocked', { todo: GAP }, (t) => {
  const { opts } = setup(t);
  assert.notEqual(policy.bashDenial('mv ~ /dev/null', opts), null);
});
