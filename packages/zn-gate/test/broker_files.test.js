'use strict';

// File helpers, run in temporary directories.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { gitStatusOf, realTargetOf, writeFileAtomic } = require('../lib/broker/files');

const haveGit = !spawnSync('git', ['--version']).error;
const git = (cwd, ...args) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });

function tmp() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zn-files-')));
}

test('writeFileAtomic creates a file, replaces it and leaves no temp file', () => {
  const dir = tmp();
  try {
    const f = path.join(dir, 'out.txt');
    writeFileAtomic(f, 'one');
    writeFileAtomic(f, 'two');
    assert.equal(fs.readFileSync(f, 'utf8'), 'two');
    assert.deepEqual(fs.readdirSync(dir), ['out.txt']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('writeFileAtomic uses mode 0600 by default', { skip: process.platform === 'win32' }, () => {
  const dir = tmp();
  try {
    const f = path.join(dir, 'secret.txt');
    writeFileAtomic(f, 'x');
    assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('writeFileAtomic fails when the directory is missing', () => {
  const dir = tmp();
  try {
    assert.throws(() => writeFileAtomic(path.join(dir, 'nope', 'f'), 'x'), { code: 'ENOENT' });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('realTargetOf returns an existing path unchanged', () => {
  const dir = tmp();
  try {
    const f = path.join(dir, 'a.txt');
    fs.writeFileSync(f, '');
    assert.equal(realTargetOf(f), f);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('realTargetOf keeps missing names as typed below an existing directory', () => {
  const dir = tmp();
  try {
    assert.equal(realTargetOf(path.join(dir, 'x', 'y', 'z.txt')), path.join(dir, 'x', 'y', 'z.txt'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('realTargetOf resolves a symlinked directory, also for a file not yet created', { skip: process.platform === 'win32' }, () => {
  const dir = tmp();
  try {
    fs.mkdirSync(path.join(dir, 'real'));
    fs.symlinkSync(path.join(dir, 'real'), path.join(dir, 'link'));
    assert.equal(realTargetOf(path.join(dir, 'link', 'new.txt')), path.join(dir, 'real', 'new.txt'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('gitStatusOf: ignored, tracked and outside', { skip: !haveGit }, () => {
  const repo = tmp();
  const plain = tmp();
  try {
    git(repo, 'init', '-q');
    fs.writeFileSync(path.join(repo, '.gitignore'), '.env\n');
    assert.equal(gitStatusOf(path.join(repo, '.env')), 'ignored');
    assert.equal(gitStatusOf(path.join(repo, 'src', 'new', 'a.js')), 'tracked');
    assert.equal(gitStatusOf(path.join(repo, 'README.md')), 'tracked');
    const out = gitStatusOf(path.join(plain, 'a.txt'));
    // A temp directory is normally outside any repository.
    if (git(plain, 'rev-parse', '--show-toplevel').status !== 0) assert.equal(out, 'outside');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(plain, { recursive: true, force: true });
  }
});
