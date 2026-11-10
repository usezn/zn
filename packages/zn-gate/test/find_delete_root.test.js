'use strict';

// find -delete with no test under the filesystem root removes everything there, so the policy refuses it.
// Inside the project a find with -delete is allowed. A find with a test (-name ...) that starts at the root
// is refused too: a test does not make a delete from / safe.

process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');

const { checkCommand } = require('../lib/destructive');
const policy = require('../lib/hooks/policy');

const home = '/home/alice';
const opts = { home, cwd: home + '/proj', env: { HOME: home } };

test('find -delete at the filesystem root is refused', () => {
  for (const c of ['find / -delete', 'find /  -delete', 'find /   -delete  ']) {
    assert.equal(checkCommand(c).verdict, 'block', c);
    assert.equal(checkCommand(c).rule, 'destructive:rm_root_home', c);
    assert.ok(policy.bashDenial(c, opts), c);
  }
});

test('find -delete inside the project is allowed', () => {
  for (const c of ['find ./tmp -delete', "find ./tmp -name '*.log' -delete"]) {
    assert.equal(checkCommand(c).verdict, 'allow', c);
    assert.equal(policy.bashDenial(c, opts), null, c);
  }
});

test('find -name -delete at the filesystem root is refused', () => {
  for (const c of ['find / -name x -delete', 'find /  -name x  -delete', 'find / -name "*.log" -delete', 'find / -type f -exec rm {} +']) {
    assert.equal(checkCommand(c).verdict, 'block', c);
    assert.ok(policy.bashDenial(c, opts), c);
  }
});

test('find from the root without a delete is allowed', () => {
  for (const c of ['find / -name x -print', 'find . -name x -delete']) {
    assert.equal(checkCommand(c).verdict, 'allow', c);
    assert.equal(policy.bashDenial(c, opts), null, c);
  }
});
