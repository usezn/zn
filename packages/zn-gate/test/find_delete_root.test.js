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

test('find with global options before the starting path is judged like find without them', () => {
  for (const c of ['find -P / -name x -delete', 'find -L / -name x -delete', 'find -H / -name x -delete', 'find -O3 / -name x -delete',
    'find -D tree / -name x -delete', 'find -P -L / -type f -exec rm {} +', 'find -P / -delete']) {
    assert.equal(checkCommand(c).verdict, 'block', c);
    assert.equal(checkCommand(c).rule, 'destructive:rm_root_home', c);
    assert.ok(policy.bashDenial(c, opts), c);
  }
  for (const c of ['find -P ./tmp -name x -delete', 'find -L . -name x -delete', 'find -P / -name x -print']) {
    assert.equal(checkCommand(c).verdict, 'allow', c);
    assert.equal(policy.bashDenial(c, opts), null, c);
  }
});

test('find -execdir, -ok and -okdir with rm are judged like -exec', () => {
  for (const c of ['find / -name x -execdir rm {} +', 'find / -name x -execdir rm {} ;', 'find / -type f -ok rm {} ;',
    'find / -name x -okdir shred {} ;', 'find /etc -execdir rm {} +', 'find -P / -name x -execdir /bin/rm {} +']) {
    assert.equal(checkCommand(c).verdict, 'block', c);
    assert.equal(checkCommand(c).rule, 'destructive:rm_root_home', c);
    assert.ok(policy.bashDenial(c, opts), c);
  }
  for (const c of ['find ./tmp -execdir rm {} +', "find . -name '*.log' -okdir rm {} ;", 'find / -name x -execdir ls {} +']) {
    assert.equal(checkCommand(c).verdict, 'allow', c);
    assert.equal(policy.bashDenial(c, opts), null, c);
  }
});
