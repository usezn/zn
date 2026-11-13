'use strict';

// gitStatusOf and realTargetOf in temporary folders: outside a repository, tracked and ignored files,
// paths that do not exist yet, and paths that go through a link.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { gitStatusOf, realTargetOf } = require('../lib/broker/files');

const haveGit = !spawnSync('git', ['--version']).error;
const git = (cwd, ...args) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
const noLinks = process.platform === 'win32';

function tmp() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zn-files-real-')));
}
function rm(...dirs) {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
}
function initRepo() {
  const repo = tmp();
  git(repo, 'init', '-q');
  fs.writeFileSync(path.join(repo, '.gitignore'), '*.secret\nbuild/\n');
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'x\n');
  git(repo, 'add', '.gitignore', 'tracked.txt');
  return repo;
}

test('gitStatusOf: an existing file in a folder outside any repository is outside', { skip: !haveGit }, () => {
  const plain = tmp();
  try {
    if (git(plain, 'rev-parse', '--show-toplevel').status === 0) return; // the temp folder sits inside a repository
    fs.writeFileSync(path.join(plain, 'a.txt'), 'x');
    assert.equal(gitStatusOf(path.join(plain, 'a.txt')), 'outside');
    assert.equal(gitStatusOf(path.join(plain, 'missing', 'deep', 'b.txt')), 'outside');
  } finally { rm(plain); }
});

test('gitStatusOf: a tracked file is tracked', { skip: !haveGit }, () => {
  const repo = initRepo();
  try {
    assert.equal(gitStatusOf(path.join(repo, 'tracked.txt')), 'tracked');
  } finally { rm(repo); }
});

test('gitStatusOf: an existing ignored file is ignored', { skip: !haveGit }, () => {
  const repo = initRepo();
  try {
    fs.writeFileSync(path.join(repo, 'token.secret'), 'x');
    assert.equal(gitStatusOf(path.join(repo, 'token.secret')), 'ignored');
  } finally { rm(repo); }
});

test('gitStatusOf: names that do not exist yet follow the ignore rules', { skip: !haveGit }, () => {
  const repo = initRepo();
  try {
    assert.equal(gitStatusOf(path.join(repo, 'new', 'deep', 'token.secret')), 'ignored');
    assert.equal(gitStatusOf(path.join(repo, 'build', 'out', 'a.js')), 'ignored');
    assert.equal(gitStatusOf(path.join(repo, 'new', 'deep', 'a.js')), 'tracked');
  } finally { rm(repo); }
});

test('gitStatusOf: a relative path is resolved before it is checked', { skip: !haveGit }, () => {
  const repo = initRepo();
  const cwd = process.cwd();
  try {
    process.chdir(repo);
    assert.equal(gitStatusOf('token.secret'), 'ignored');
    assert.equal(gitStatusOf('tracked.txt'), 'tracked');
  } finally {
    process.chdir(cwd);
    rm(repo);
  }
});

test('gitStatusOf: a path below a linked folder is judged where the link points', { skip: (!haveGit && 'git is not installed') || (noLinks && 'symbolic links need privileges on Windows') }, () => {
  const repo = initRepo();
  const plain = tmp();
  try {
    if (git(plain, 'rev-parse', '--show-toplevel').status === 0) return;
    fs.symlinkSync(plain, path.join(repo, 'link'));
    // git is run in the folder the link points to, so the repository that holds the link does not count.
    const out = gitStatusOf(path.join(repo, 'link', 'new.txt'));
    assert.equal(out, 'outside');
  } finally { rm(repo, plain); }
});

test('realTargetOf: a symlink to a file resolves to the file', { skip: noLinks && 'symbolic links need privileges on Windows' }, () => {
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, 'real.txt'), 'x');
    fs.symlinkSync(path.join(dir, 'real.txt'), path.join(dir, 'alias.txt'));
    assert.equal(realTargetOf(path.join(dir, 'alias.txt')), path.join(dir, 'real.txt'));
  } finally { rm(dir); }
});

test('realTargetOf: a link to a folder that is missing keeps the typed path', { skip: noLinks && 'symbolic links need privileges on Windows' }, () => {
  const dir = tmp();
  try {
    fs.symlinkSync(path.join(dir, 'gone'), path.join(dir, 'dangling'));
    const typed = path.join(dir, 'dangling', 'x.txt');
    assert.equal(realTargetOf(typed), path.join(dir, 'dangling', 'x.txt'));
  } finally { rm(dir); }
});

test('realTargetOf: links and missing names in the middle of a path', { skip: noLinks && 'symbolic links need privileges on Windows' }, () => {
  const dir = tmp();
  try {
    fs.mkdirSync(path.join(dir, 'real', 'sub'), { recursive: true });
    fs.symlinkSync(path.join(dir, 'real'), path.join(dir, 'link'));
    assert.equal(realTargetOf(path.join(dir, 'link', 'sub', 'a', 'b.txt')), path.join(dir, 'real', 'sub', 'a', 'b.txt'));
    assert.equal(realTargetOf(path.join(dir, 'link', 'sub')), path.join(dir, 'real', 'sub'));
  } finally { rm(dir); }
});

test('realTargetOf: a relative path becomes absolute', () => {
  const dir = tmp();
  const cwd = process.cwd();
  try {
    process.chdir(dir);
    assert.equal(realTargetOf(path.join('not', 'yet.txt')), path.join(dir, 'not', 'yet.txt'));
  } finally {
    process.chdir(cwd);
    rm(dir);
  }
});
