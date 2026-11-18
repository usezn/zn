'use strict';

process.env.ZN_STATS = 'off';

// A cd in a branch that may not run (if/else, case, after && or ||) leaves the folder it may have been in before or the one it names:
// a protected folder reached in one branch stays protected after a cd to another folder in a later branch. A cd to a folder a variable
// names leaves "." and ".." possibly protected. Mirrors tests/test_destructive_cd_in_branches.py. Only example paths; nothing is run.

const test = require('node:test');
const assert = require('node:assert/strict');

const { checkCommand } = require('../lib/destructive');

const rule = (cmd) => { const r = checkCommand(cmd); return r.verdict === 'block' ? r.rule.replace('destructive:', '') : 'allow'; };

test('a protected folder reached in one branch stays protected after a cd in another branch', () => {
  assert.equal(rule('if [ -d x ]; then cd ~; else cd /tmp/example; fi; rm -rf .'), 'rm_root_home');
  assert.equal(rule('if [ -d x ]; then cd /tmp/example; else cd ~; fi; rm -rf .'), 'rm_root_home');
  assert.equal(rule('if [ -d x ]; then cd ~; fi; rm -rf .'), 'rm_root_home');
  assert.equal(rule('if a; then cd /tmp/a; elif b; then cd ~; else cd /tmp/c; fi; rm -rf .'), 'rm_root_home');
  assert.equal(rule('case $A in a) cd ~;; b) cd /tmp/example;; esac; rm -rf .'), 'rm_root_home');
  assert.equal(rule('cd /tmp/example || cd ~; rm -rf .'), 'rm_root_home');
  assert.equal(rule('[ -d x ] && cd ~; rm -rf .'), 'rm_root_home');
  assert.equal(rule('cd ~ || cd /tmp/example; rm -rf .'), 'rm_root_home');
  assert.equal(rule('if x; then cd ~; else cd /tmp/example; fi; find . -delete'), 'rm_root_home');
});

test('a branch that moves to a project folder only is not protected', () => {
  assert.equal(rule('if a; then cd /tmp/a; else cd /tmp/b; fi; rm -rf .'), 'allow');
  assert.equal(rule('case $A in a) cd /tmp/a;; b) cd /tmp/b;; esac; rm -rf .'), 'allow');
  assert.equal(rule('if [ -d app ]; then cd app; fi; rm -rf build/'), 'allow');
  assert.equal(rule('if [ -d app ]; then cd app; fi; rm -rf .'), 'allow');
  assert.equal(rule('cd /tmp/example/app && rm -rf build/'), 'allow');
  assert.equal(rule('cd /tmp/example && (cd ~; ls); rm -rf .'), 'allow');
});

test('a cd to a folder a variable names makes the folders above it possibly protected', () => {
  assert.equal(rule('cd "$X" && rm -rf ..'), 'rm_root_home');
  assert.equal(rule('cd $X; rm -rf ..'), 'rm_root_home');
  assert.equal(rule('cd ${PROJECT}; rm -rf ..'), 'rm_root_home');
  assert.equal(rule('cd "$X/proj" && rm -rf ../..'), 'rm_root_home');
  assert.equal(rule('if [ -d x ]; then cd "$X"; fi; rm -rf ..'), 'rm_root_home');
  assert.equal(rule('cd "$X" && find .. -delete'), 'rm_root_home');
});

test('the variable folder itself and a name below it are not protected', () => {
  assert.equal(rule('cd "$X" && rm -rf build/'), 'allow');
  assert.equal(rule('cd "$X" && rm -rf .'), 'allow');
  assert.equal(rule('cd "$X/proj" && rm -rf .'), 'allow');
  assert.equal(rule('cd "$X/proj" && rm -rf ..'), 'allow');
  assert.equal(rule('cd "$(mktemp -d)" && rm -rf .'), 'allow');
  assert.equal(rule('rm -rf .'), 'allow');
  assert.equal(rule('rm -rf ..'), 'allow');
});

test('a long chain of branches is read in linear time', () => {
  const chain = 'if x; then cd /tmp/example; fi; '.repeat(400);
  const t0 = Date.now();
  const r = rule(chain + 'rm -rf .');
  assert.ok(Date.now() - t0 < 2000);
  assert.ok(r === 'allow' || r === 'too_many_commands');
  const t1 = Date.now();
  rule('if x; then cd ~; fi; ' + chain + 'rm -rf .');
  assert.ok(Date.now() - t1 < 2000);
});
