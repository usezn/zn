'use strict';

// cargo build, cargo test and cargo build --release stay allowed by the destructive policy. There is no cargo rule
// (the six rules cover rm, disks, permissions, pipes to shells, remote-code downloads and fork bombs), so a cargo clean
// aimed at the home folder is allowed today: a known gap, kept as a todo until a rule exists.

process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const { checkCommand } = require('../lib/destructive');

for (const cmd of ['cargo build', 'cargo test', 'cargo build --release']) {
  test('destructive policy keeps allowing ' + cmd, () => {
    assert.equal(checkCommand(cmd).verdict, 'allow');
  });
}

test('cargo clean aimed at the home folder is refused', { todo: 'known gap: no cargo rule in lib/destructive.js; cargo clean --target-dir ~ is allowed today' }, () => {
  assert.equal(checkCommand('cargo clean --target-dir ~').verdict, 'block');
});
