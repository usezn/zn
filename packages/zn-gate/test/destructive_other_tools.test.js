'use strict';

process.env.ZN_STATS = 'off';

// Other tools that are destructive but are not covered by the destructive-command rules.
// docs/destructive-commands.md lists `git clean` under "What it does not do", so the blocking
// assertions below are todo: they stay visible and a future rule that blocks them shows up as a todo that passes.
// The allow assertions pin what the policy really does today. Fake paths and fake bucket names only.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const policy = require('../lib/hooks/policy');
const { checkCommand } = require('../lib/destructive');

const OPTS = { cwd: path.join(__dirname, '..') };
const NOT_COVERED = 'product decision: other tools are outside the destructive-command rules (docs/destructive-commands.md, "What it does not do"); the policy allows this today';

function denied(cmd) {
  return policy.bashDenial(cmd, OPTS) !== null || checkCommand(cmd).verdict === 'block';
}

test('git stash list is allowed (read-only git command)', () => {
  assert.equal(policy.bashDenial('git stash list', OPTS), null);
  assert.equal(checkCommand('git stash list').verdict, 'allow');
});

test('git clean -fdx is blocked as a destructive command', { todo: NOT_COVERED }, () => {
  assert.equal(denied('git clean -fdx'), true);
});

test('tar xzf archive.tgz into the project folder is allowed', () => {
  assert.equal(policy.bashDenial('tar xzf archive.tgz', OPTS), null);
  assert.equal(checkCommand('tar xzf archive.tgz').verdict, 'allow');
});

test('tar -C / -xzf archive.tgz (extract to the filesystem root) is blocked', { todo: NOT_COVERED }, () => {
  assert.equal(denied('tar -C / -xzf archive.tgz'), true);
});

test('aws s3 ls on a bucket is allowed', () => {
  assert.equal(policy.bashDenial('aws s3 ls s3://example-bucket', OPTS), null);
  assert.equal(checkCommand('aws s3 ls s3://example-bucket').verdict, 'allow');
});

test('aws s3 rm s3://example-bucket --recursive is blocked', { todo: NOT_COVERED }, () => {
  assert.equal(denied('aws s3 rm s3://example-bucket --recursive'), true);
});

test('control: a recursive delete of a top-level system folder is still blocked by rm_root_home', () => {
  assert.notEqual(policy.bashDenial('rm -rf /usr', OPTS), null);
  assert.equal(checkCommand('rm -rf /usr').rule, 'destructive:rm_root_home');
});
