'use strict';
process.env.ZN_STATS = 'off';

// projectPlaces lists the folders a program must not come from: the working folder, the git work tree around it and
// the project the agent names in CLAUDE_PROJECT_DIR. programInProject says whether a file's real path is in one of them.
// Every case passes env explicitly, with HOME set to a temporary folder, so the real home folder is never used.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const exe = require('../lib/exe');
const { tempDir } = require('./helpers/tmp');

const posix = { skip: process.platform === 'win32' };

// A temporary git repository (an empty .git folder is enough) with a src/ folder, and a separate home folder.
function repo(t) {
  const root = tempDir(t, 'zn-places-repo-');
  fs.mkdirSync(path.join(root, '.git'));
  fs.mkdirSync(path.join(root, 'src'));
  const home = tempDir(t, 'zn-places-home-');
  return { root, src: path.join(root, 'src'), env: { HOME: home } };
}

test('projectPlaces lists the repository root once when the working folder is the root', posix, (t) => {
  const { root, env } = repo(t);
  assert.deepEqual(exe.projectPlaces(root, env, false), [root]);
});

test('projectPlaces lists the working folder and the repository root above it', posix, (t) => {
  const { root, src, env } = repo(t);
  const places = exe.projectPlaces(src, env, false);
  assert.deepEqual(places, [src, root]);
  assert.equal(places.filter((p) => p === root).length, 1);
});

test('projectPlaces gives the real path of a working folder reached through a link', posix, (t) => {
  const { root, env } = repo(t);
  const outside = tempDir(t, 'zn-places-link-');
  const link = path.join(outside, 'project-link');
  fs.symlinkSync(root, link, 'dir');
  assert.deepEqual(exe.projectPlaces(link, env, false), [root]);
});

test('projectPlaces adds an absolute CLAUDE_PROJECT_DIR and ignores a relative one', posix, (t) => {
  const { root, env } = repo(t);
  const other = tempDir(t, 'zn-places-agent-');
  assert.deepEqual(exe.projectPlaces(root, { ...env, CLAUDE_PROJECT_DIR: other }, false), [root, other]);
  assert.deepEqual(exe.projectPlaces(root, { ...env, CLAUDE_PROJECT_DIR: 'relative/project' }, false), [root]);
  assert.deepEqual(exe.projectPlaces(root, { ...env, CLAUDE_PROJECT_DIR: root }, false), [root]);
});

test('projectPlaces leaves out the home folder and the folders above it, not a folder inside it', posix, (t) => {
  const { root, env } = repo(t);
  const home = path.join(root, 'home');
  const inside = path.join(home, 'work');
  fs.mkdirSync(inside, { recursive: true });
  const homeEnv = { ...env, HOME: home };
  // The working folder is the home folder: neither it nor the repository root above it is a project place.
  assert.deepEqual(exe.projectPlaces(home, homeEnv, false), []);
  assert.deepEqual(exe.projectPlaces(root, { ...homeEnv, CLAUDE_PROJECT_DIR: home }, false), []);
  // A project folder inside the home folder stays; the repository root above home does not.
  assert.deepEqual(exe.projectPlaces(inside, homeEnv, false), [inside]);
});

test('programInProject is true for a file below the project and false for one outside it', posix, (t) => {
  const { root, src, env } = repo(t);
  const inside = path.join(src, 'tool');
  fs.writeFileSync(inside, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const elsewhere = tempDir(t, 'zn-places-other-');
  const outside = path.join(elsewhere, 'tool');
  fs.writeFileSync(outside, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  assert.equal(exe.programInProject(inside, env, root), true);
  assert.equal(exe.programInProject(inside, env, src), true);
  assert.equal(exe.programInProject(outside, env, root), false);
  // A file in CLAUDE_PROJECT_DIR counts as the project too.
  assert.equal(exe.programInProject(outside, { ...env, CLAUDE_PROJECT_DIR: elsewhere }, root), true);
});
