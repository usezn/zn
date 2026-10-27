'use strict';

// Edge cases of the PATH filter (lib/exe.js): a home folder that is a git work tree (dotfiles), a project without .git,
// and a repository inside another one. Fake programs only leave a marker; none of them may run.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const exe = require('../lib/exe');
const { tempDir } = require('./helpers/tmp');

const POSIX = process.platform !== 'win32';

function gitInit(dir) {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', dir], { stdio: 'ignore' });
}

function fakeProgram(dir, name, marker) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), '#!/bin/sh\necho "' + name + ' $*" >> ' + JSON.stringify(marker) + '\nexit 0\n', { mode: 0o755 });
  return dir;
}

const list = (s) => s.split(':').filter(Boolean);

test('a home folder that is a git work tree: the home is a project, its tool folders are not', { skip: !POSIX }, (t) => {
  const home = tempDir(t, 'zn-edge-home-');
  const marker = path.join(tempDir(t, 'zn-edge-mark-'), 'ran.txt');
  gitInit(home);
  const tools = path.join(home, 'tools', 'bin');
  const keep = [path.join(home, '.local', 'bin'), path.join(home, 'bin'), path.join(home, '.nvm', 'versions', 'node', 'v20.0.0', 'bin'), path.join(home, '.volta', 'bin'), '/usr/bin'];
  for (const d of [tools, ...keep.slice(0, 4)]) fs.mkdirSync(d, { recursive: true });
  const PATH = [tools, ...keep].join(':');
  for (const cwd of [home, path.join(home, 'notes')]) {
    fs.mkdirSync(cwd, { recursive: true });
    assert.deepEqual(list(exe.trustedPath(PATH, cwd, { HOME: home })), keep, 'cwd ' + cwd);
  }
  // CLAUDE_PROJECT_DIR inside the home is skipped as before.
  const proj = path.join(home, 'work', 'p');
  fs.mkdirSync(path.join(proj, 'bin'), { recursive: true });
  assert.deepEqual(list(exe.trustedPath([path.join(proj, 'bin'), ...keep].join(':'), home, { HOME: home, CLAUDE_PROJECT_DIR: proj })), keep);
  // findProgram: a git in the home's own folder is never started, one in ~/.local/bin is found.
  fakeProgram(tools, 'git', marker);
  assert.equal(exe.findProgram('git', { HOME: home, PATH: tools }, home), null);
  fakeProgram(keep[0], 'git', marker);
  assert.equal(exe.findProgram('git', { HOME: home, PATH: [tools, keep[0]].join(':') }, home), path.join(keep[0], 'git'));
  assert.equal(fs.existsSync(marker), false);
  // projectPlaces holds the home, never the folders above it.
  const places = exe.projectPlaces(home, { HOME: home }, false);
  assert.ok(places.includes(fs.realpathSync(home)));
  assert.ok(!places.includes(path.dirname(fs.realpathSync(home))));
});

test('a home folder that is not a git work tree stays trusted as a whole', { skip: !POSIX }, (t) => {
  const home = tempDir(t, 'zn-edge-plainhome-');
  const tools = path.join(home, 'tools', 'bin');
  fs.mkdirSync(tools, { recursive: true });
  assert.deepEqual(list(exe.trustedPath(tools + ':/usr/bin', home, { HOME: home })), [tools, '/usr/bin']);
  assert.ok(!exe.projectPlaces(home, { HOME: home }, false).includes(fs.realpathSync(home)));
});

test('a project without .git: CLAUDE_PROJECT_DIR, or the nearest folder with a project file, covers the folders above the cwd', { skip: !POSIX }, (t) => {
  const home = tempDir(t, 'zn-edge-home-');
  const proj = tempDir(t, 'zn-edge-nogit-');
  const other = tempDir(t, 'zn-edge-other-');
  fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
  fs.mkdirSync(path.join(proj, 'bin'));
  fs.mkdirSync(path.join(other, 'bin'));
  const PATH = [path.join(proj, 'bin'), path.join(other, 'bin'), '/usr/bin'].join(':');
  const cwd = path.join(proj, 'src');
  const env = { HOME: home };
  // The agent names the project.
  assert.deepEqual(list(exe.trustedPath(PATH, cwd, { ...env, CLAUDE_PROJECT_DIR: proj })), [path.join(other, 'bin'), '/usr/bin']);
  // It does not: a project file marks the project.
  fs.writeFileSync(path.join(proj, 'package.json'), '{}');
  assert.deepEqual(list(exe.trustedPath(PATH, cwd, env)), [path.join(other, 'bin'), '/usr/bin']);
  assert.ok(exe.projectPlaces(cwd, env, false).includes(fs.realpathSync(proj)));
  // findProgram agrees.
  const marker = path.join(tempDir(t, 'zn-edge-mark-'), 'ran.txt');
  fakeProgram(path.join(proj, 'bin'), 'git', marker);
  assert.equal(exe.findProgram('git', { ...env, PATH: path.join(proj, 'bin') }, cwd), null);
  assert.equal(fs.existsSync(marker), false);
});

test('a project without .git and without any marker: only the folder zn runs in is known (documented limit)', { skip: !POSIX }, (t) => {
  const home = tempDir(t, 'zn-edge-home-');
  const proj = tempDir(t, 'zn-edge-bare-');
  fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
  fs.mkdirSync(path.join(proj, 'bin'));
  const cwd = path.join(proj, 'src');
  assert.deepEqual(list(exe.trustedPath(path.join(proj, 'bin') + ':' + cwd, cwd, { HOME: home })), [path.join(proj, 'bin')]);
});

test('a repository inside another one: the outer work tree is a project too, up to the home folder', { skip: !POSIX }, (t) => {
  const home = tempDir(t, 'zn-edge-home-');
  const outer = tempDir(t, 'zn-edge-outer-');
  const inner = path.join(outer, 'packages', 'inner');
  gitInit(outer);
  gitInit(inner);
  fs.mkdirSync(path.join(inner, 'src'), { recursive: true });
  fs.mkdirSync(path.join(outer, 'bin'));
  fs.mkdirSync(path.join(inner, 'bin'));
  const PATH = [path.join(outer, 'bin'), path.join(inner, 'bin'), '/usr/bin'].join(':');
  assert.deepEqual(list(exe.trustedPath(PATH, path.join(inner, 'src'), { HOME: home })), ['/usr/bin']);
  const marker = path.join(tempDir(t, 'zn-edge-mark-'), 'ran.txt');
  fakeProgram(path.join(outer, 'bin'), 'git', marker);
  assert.equal(exe.findProgram('git', { HOME: home, PATH: path.join(outer, 'bin') }, path.join(inner, 'src')), null);
  assert.equal(fs.existsSync(marker), false);
});

test('nested repositories never reach the home folder or above, and the climb is bounded', { skip: !POSIX }, (t) => {
  // A repository that holds the home (dotfiles) around a project does not make the home a project.
  const home = tempDir(t, 'zn-edge-home-');
  gitInit(home);
  const proj = path.join(home, 'code', 'p');
  gitInit(proj);
  const tools = path.join(home, 'tools', 'bin');
  fs.mkdirSync(tools, { recursive: true });
  assert.deepEqual(list(exe.trustedPath(tools + ':/usr/bin', proj, { HOME: home })), [tools, '/usr/bin']);
  // A work tree that contains the home is not a project.
  const outer = tempDir(t, 'zn-edge-outer-');
  gitInit(outer);
  const home2 = path.join(outer, 'home');
  const proj2 = path.join(home2, 'p');
  gitInit(proj2);
  fs.mkdirSync(path.join(outer, 'bin'));
  assert.deepEqual(list(exe.trustedPath(path.join(outer, 'bin'), proj2, { HOME: home2 })), [path.join(outer, 'bin')]);
  // At most 8 levels above the nearest work tree are looked at.
  const base = tempDir(t, 'zn-edge-deep-');
  gitInit(base);
  let cur = base;
  const levels = [];
  for (let i = 1; i <= 10; i++) { cur = path.join(cur, 'd' + i); fs.mkdirSync(cur); levels.push(cur); }
  gitInit(levels[9]);
  gitInit(levels[1]); // 8 levels above the nearest: counts
  const places = exe.projectPlaces(levels[9], { HOME: home }, false).map((p) => fs.realpathSync(p));
  assert.ok(places.includes(fs.realpathSync(levels[1])));
  assert.ok(!places.includes(fs.realpathSync(base)));
});
