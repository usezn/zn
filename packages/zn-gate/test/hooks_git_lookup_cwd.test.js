'use strict';
// The git lookup of the hook runner (a Write whose text holds markers) uses the event folder, not the hook process's folder.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const FILES = path.resolve(__dirname, '../lib/broker/files.js');
const posix = process.platform !== 'win32';

function setup() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'zn-gitcwd-')));
  const project = path.join(base, 'project');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(path.join(project, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(project, '.git'));
  fs.mkdirSync(outside);
  const marker = path.join(base, 'fake-git-ran');
  const fake = path.join(project, 'bin', 'git');
  fs.writeFileSync(fake, '#!/bin/sh\necho ran > ' + JSON.stringify(marker) + '\nexit 0\n', { mode: 0o755 });
  return { base, project, outside, marker };
}

const realGit = spawnSync('git', ['--version']).status === 0;

test('git in an absolute project/bin PATH entry is not run when the event folder is the project', { skip: !posix }, () => {
  const t = setup();
  try {
    const script = 'const {gitStatusOf}=require(' + JSON.stringify(FILES) + ');' +
      'process.stdout.write(gitStatusOf(' + JSON.stringify(path.join(t.project, 'a.txt')) + ',' + JSON.stringify(t.project) + '));';
    const env = { ...process.env, PATH: path.join(t.project, 'bin') + path.delimiter + process.env.PATH };
    delete env.CLAUDE_PROJECT_DIR;
    const r = spawnSync(process.execPath, ['-e', script], { cwd: t.outside, env, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(fs.existsSync(t.marker), false, 'the fake git in the project ran');
    if (realGit) assert.notStrictEqual(r.stdout, 'unknown', 'the real git was not found');
  } finally {
    fs.rmSync(t.base, { recursive: true, force: true });
  }
});

test('the real git is still found and used for a folder outside any work tree', { skip: !posix || !realGit }, () => {
  const t = setup();
  try {
    const plain = path.join(t.base, 'plain');
    fs.mkdirSync(plain);
    const script = 'const {gitStatusOf}=require(' + JSON.stringify(FILES) + ');' +
      'process.stdout.write(gitStatusOf(' + JSON.stringify(path.join(plain, 'a.txt')) + ',' + JSON.stringify(plain) + '));';
    const r = spawnSync(process.execPath, ['-e', script], { cwd: t.outside, env: { ...process.env, GIT_CEILING_DIRECTORIES: t.base }, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.stdout, 'outside');
  } finally {
    fs.rmSync(t.base, { recursive: true, force: true });
  }
});
