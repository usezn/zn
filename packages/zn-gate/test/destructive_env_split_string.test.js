'use strict';

process.env.ZN_STATS = 'off';

// env -S / --split-string takes a command line. checkCommand() reads it as a nested command, and refuses it when the
// nesting is deeper than the checker follows. Only the text is checked; nothing is run.
// Mirrored by packages/zn-gate-py/tests/test_destructive_env_split_string.py.

const test = require('node:test');
const assert = require('node:assert/strict');

const { checkCommand, denial } = require('../lib/destructive');

const nest = (cmd, n) => { let s = cmd; for (let i = 0; i < n; i++) s = 'env -S ' + JSON.stringify(s); return s; };

test('env -S variants are blocked by checkCommand', () => {
  for (const c of [
    'env -S "rm -rf /"',
    'env --split-string="rm -rf /"',
    'env --split-string "rm -rf /"',
    'env -S "dd of=/dev/sda if=/dev/zero"',
  ]) assert.equal(checkCommand(c).verdict, 'block', c);
});

test('a benign env -S command stays allowed', () => {
  for (const c of ['env -S "echo hello"', 'env --split-string="echo hello"', nest('echo hello', 2)]) {
    assert.equal(checkCommand(c).verdict, 'allow', c);
  }
});

test('nested env -S is blocked at every depth, including past the depth bound', () => {
  for (let n = 1; n <= 8; n++) assert.equal(checkCommand(nest('rm -rf /', n)).verdict, 'block', 'depth ' + n);
});

test('the hook denial agrees with checkCommand', () => {
  assert.ok(denial('env -S "rm -rf /"', null));
  assert.equal(denial('env -S "echo hello"', null), null);
});
