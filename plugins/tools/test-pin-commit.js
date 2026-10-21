#!/usr/bin/env node
'use strict';

/**
 * Tests the lookup of the commit that pinned the plugin, as written in
 * .github/workflows/plugin-repo.yml and plugins/claude-dir/verify.yml. Each
 * command is taken from the workflow file and run in a small synthetic
 * repository where the pin's pull request was opened before the release
 * reached main and was brought up to date with main afterwards: the found
 * commit must contain the release tag. Needs git and bash, no network.
 *
 *   node plugins/tools/test-pin-commit.js
 */

const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const LOCK = 'plugins/zn-gate/scripts/zn-gate.lock.json';
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zn-pin-commit-')));
const repo = path.join(tmp, 'zn');

const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com',
  '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], { encoding: 'utf8' }).trim();
const writeLock = (version) => {
  fs.mkdirSync(path.join(repo, path.dirname(LOCK)), { recursive: true });
  fs.writeFileSync(path.join(repo, LOCK), JSON.stringify({ version }) + '\n');
};
const commit = (msg) => { git('add', '-A'); git('commit', '-q', '-m', msg); return git('rev-parse', 'HEAD'); };

/** The `git -C zn log -1 ...` command substitution assigned to `name` in a workflow file. */
function lookup(file, name) {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const m = text.match(new RegExp('^\\s*' + name + '="\\$\\((git -C zn log -1 [^)]*)\\)"\\r?$', 'm'));
  assert.ok(m, `${file}: no ${name}="$(git -C zn log -1 ...)" line`);
  return m[1];
}

/** Runs a workflow command in a directory whose zn/ is the synthetic repository. */
const run = (cmd, env = {}) => execFileSync('bash', ['-c', 'set -euo pipefail; ' + cmd],
  { cwd: tmp, encoding: 'utf8', env: { ...process.env, ...env } }).trim();

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// main pins 1.13.0. The pin pull request starts there and pins 1.13.1 before the release
// is on main; then the release lands on main with its tag, the pull request merges main
// in (to be up to date) and main merges the pull request.
fs.mkdirSync(repo);
execFileSync('git', ['init', '-q', repo]);
git('checkout', '-q', '-b', 'main');
writeLock('1.13.0');
commit('pin 1.13.0');
git('checkout', '-q', '-b', 'pin');
writeLock('1.13.1');
const pinCommit = commit('pin 1.13.1');
git('checkout', '-q', 'main');
fs.writeFileSync(path.join(repo, 'release.txt'), '1.13.1\n');
commit('release 1.13.1');
git('tag', 'v1.13.1');
git('checkout', '-q', 'pin');
git('merge', '-q', '--no-ff', '--no-edit', 'main');
git('checkout', '-q', 'main');
git('merge', '-q', '--no-ff', '--no-edit', 'pin');
const mergeOnMain = git('rev-parse', 'HEAD');
const containsTag = (c) => {
  try { git('merge-base', '--is-ancestor', 'v1.13.1', c); return true; } catch { return false; }
};

test('the scenario reproduces the failure: following the pull request finds a commit without the tag', () => {
  const plain = git('log', '-1', '--format=%H', 'HEAD', '--', LOCK);
  assert.strictEqual(plain, pinCommit);
  assert.strictEqual(containsTag(plain), false);
});

test('plugin-repo.yml picks the merge on main, which contains the release tag', () => {
  const found = run(lookup('.github/workflows/plugin-repo.yml', 'source'));
  assert.strictEqual(found, mergeOnMain);
  assert.ok(containsTag(found));
});

test('verify.yml expects the same commit for a release pull request', () => {
  const found = run(lookup('plugins/claude-dir/verify.yml', 'pin'), { lock: LOCK });
  assert.strictEqual(found, run(lookup('.github/workflows/plugin-repo.yml', 'source')));
});

test('verify.yml on main accepts the merge on main and an older pull request pin commit, and nothing else', () => {
  const text = fs.readFileSync(path.join(ROOT, 'plugins/claude-dir/verify.yml'), 'utf8');
  const m = text.match(/^\s*(\{ git -C zn log --first-parent [^}]*\}) \| grep -x "\$SOURCE" >\/dev\/null/m);
  assert.ok(m, 'verify.yml: no pin check on main with both walks');
  const check = (source) => run(m[1] + ' | grep -x "$SOURCE" >/dev/null', { lock: LOCK, SOURCE: source });
  check(mergeOnMain);
  check(pinCommit);
  assert.throws(() => check(git('rev-parse', 'v1.13.1')));
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log('  ok   ' + name);
  } catch (e) {
    failed++;
    console.log('  FAIL ' + name + '\n       ' + String(e.message).split('\n').join('\n       '));
  }
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${tests.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
