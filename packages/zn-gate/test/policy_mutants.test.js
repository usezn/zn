'use strict';

// Policy checks that the other policy tests left open: a glob over a folder
// with too many entries, an empty or non-string path, and the home folder given
// in the options. Folders are made in the system temp folder and removed
// afterwards; every value is fake.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const policy = require('../lib/hooks/policy');

const created = [];
test.after(() => {
  for (const d of created) fs.rmSync(d, { recursive: true, force: true });
});
function tmp(prefix) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  created.push(d);
  return d;
}

test('a glob over a folder with more than 5000 entries is refused as too broad', () => {
  const root = tmp('zn-glob-');
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  const big = path.join(root, 'big');
  fs.mkdirSync(big);
  for (let i = 0; i < 5000; i++) fs.writeFileSync(path.join(big, 'f' + i), '');
  // Exactly at the limit: still read, and nothing in it matches.
  assert.equal(policy.globClass(big + '/*.zzz', { home, cwd: root }), null);
  fs.writeFileSync(path.join(big, 'f5000'), '');
  assert.deepEqual(policy.globClass(big + '/*.zzz', { home, cwd: root }), { kind: 'credential', reason: 'a pattern too broad to check' });
});

test('classifyPath returns null for an empty or non-string path, even when the working folder is protected', () => {
  const home = tmp('zn-home-');
  const znState = path.join(home, '.zn');
  fs.mkdirSync(znState);
  // The folder itself is protected, so an empty path (which would resolve to it) must not be read as that folder.
  assert.equal(policy.classifyPath(znState, { home, cwd: home }).kind, 'zn_state');
  assert.equal(policy.classifyPath('', { home, cwd: znState }), null);
  for (const bad of [null, undefined, 0, 5, {}, [], true]) {
    assert.equal(policy.classifyPath(bad, { home, cwd: znState }), null, 'path ' + JSON.stringify(bad));
  }
});

test('a cd with no target or ~ leads to the home folder given in the options', () => {
  const root = tmp('zn-cd-');
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'project');
  fs.mkdirSync(home);
  fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(home, '.env'), 'API_KEY=FAKEVALUE1234567890\n');
  for (const cmd of ['cd ~ && cat .env', 'cd && cat .env']) {
    const denial = policy.bashDenial(cmd, { home, cwd });
    assert.ok(denial, cmd + ' must be refused');
    assert.ok(denial.includes('changes to ' + home), 'the folder named is the home given: ' + denial);
  }
  assert.equal(policy.bashDenial('cat .env', { home, cwd }), null, 'without the cd the project has no .env');
});

test('without a home in the options a cd ~ leads to the home of the current user', () => {
  const root = tmp('zn-cd-default-');
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'project');
  fs.mkdirSync(home);
  fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(home, '.env'), 'API_KEY=FAKEVALUE1234567890\n');
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    if (os.homedir() !== home) return; // the host reads the home from somewhere else
    const denial = policy.bashDenial('cd ~ && cat .env', { cwd });
    assert.ok(denial && denial.includes('changes to ' + home), String(denial));
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
