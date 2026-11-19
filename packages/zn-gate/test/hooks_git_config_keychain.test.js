'use strict';

// .git/config can hold credentials in remote URLs and the macOS login keychain holds secrets: both are credential
// files. git commands never name the config file, so they keep working. Fake paths and values only.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const policy = require('../lib/hooks/policy');

const home = path.resolve('/home/fakeuser');
const opts = { home, cwd: path.join(home, 'proj'), env: { HOME: home } };

test('.git/config is a credential file at any depth, Windows spelling too', () => {
  const paths = [
    '.git/config',
    'proj/.git/config',
    '~/proj/sub/deep/.git/config',
    '$HOME/proj/.git/config',
    'C:\\Users\\fakeuser\\proj\\.git\\config',
    '.git\\config',
  ];
  for (const p of paths) {
    const c = policy.classifyPath(p, opts);
    assert.ok(c && c.kind === 'credential', `should be a credential: ${p}`);
    assert.ok(policy.readDenial(p, opts), `read should be refused: ${p}`);
  }
});

test('other git files are not credentials', () => {
  for (const p of ['.gitconfig', '~/.gitconfig', '.git/HEAD', '.git/config.bak', '.git/hooks/pre-commit', '.gitignore', 'src/git/config', 'notes.git/config.txt']) {
    assert.equal(policy.classifyPath(p, opts), null, `should not be classified: ${p}`);
  }
  assert.equal(policy.readDenial('.git/HEAD', opts), null);
});

test('macOS keychain files are credentials', () => {
  for (const p of ['~/Library/Keychains/login.keychain-db', '~/Library/Keychains/work.keychain-db', '$HOME/Library/Keychains/login.keychain',
    '/Users/fakeuser/Library/Keychains/login.keychain-db']) {
    const c = policy.classifyPath(p, opts);
    assert.ok(c && c.kind === 'credential', `should be a credential: ${p}`);
    assert.ok(policy.readDenial(p, opts), `read should be refused: ${p}`);
  }
  assert.equal(policy.classifyPath('~/Library/Keychains/README.txt', opts), null);
  assert.equal(policy.classifyPath('~/Library/Preferences/app.plist', opts), null);
});

test('commands that read the files are refused', () => {
  for (const c of ['cat .git/config', 'cat ~/proj/.git/config', 'grep url .git/config',
    'cat ~/Library/Keychains/login.keychain-db', 'cp ~/Library/Keychains/login.keychain-db out.db']) {
    assert.ok(policy.bashDenial(c, opts), `should be refused: ${c}`);
  }
});

test('git commands and ordinary files keep working', () => {
  for (const c of ['git remote -v', 'git config --get remote.origin.url', 'git config --list', 'git config user.name fake',
    'git -C proj remote get-url origin', 'git status', 'git fetch origin', 'git --git-dir=.git log --oneline',
    'git clone https://example.com/r.git', 'cat .gitconfig', 'cat .git/HEAD', 'ls .git', 'cat Library/notes.txt']) {
    assert.equal(policy.bashDenial(c, opts), null, `should be allowed: ${c}`);
  }
});
