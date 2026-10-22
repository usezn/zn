'use strict';

process.env.ZN_STATS = 'off';

// A repository controls its own folders. A project install and the atomic
// writer must never write through a planted symlink or outside the project.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { getAdapter } = require('../lib/agents');
const { writeFileAtomic } = require('../lib/broker/files');
const { tempDir } = require('./helpers/tmp');

const CASES = [
  ['claude-code', '.claude/settings.json'],
  ['codex', '.codex/hooks.json'],
  ['cursor', '.cursor/hooks.json'],
  ['gemini', '.gemini/settings.json'],
  ['copilot', '.github/hooks/zn-gate.json'],
  ['antigravity', '.agents/hooks.json'],
  ['opencode', '.opencode/plugins/zn-gate.js'],
];

function link(t, target, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.symlinkSync(target, file);
  } catch (err) {
    if (err.code === 'EPERM' || err.code === 'EACCES') return t.skip('symlinks are not available here');
    throw err;
  }
  return true;
}

function setup(t) {
  const root = tempDir(t, 'zn-psl-');
  const project = path.join(root, 'project');
  const home = path.join(root, 'home');
  const outside = path.join(root, 'outside');
  for (const d of [project, home, outside]) fs.mkdirSync(d, { recursive: true });
  return { root, project, home, outside, opts: { scope: 'project', projectDir: project, home, mcp: false } };
}

for (const [id, rel] of CASES) {
  test(id + ': project install refuses a config file that is a symlink to a file outside', (t) => {
    const s = setup(t);
    const victim = path.join(s.outside, 'victim.json');
    fs.writeFileSync(victim, '{"keep":true}\n');
    if (!link(t, victim, path.join(s.project, rel))) return;
    assert.throws(() => getAdapter(id).install(s.opts), /Refusing to write .*symbolic link/);
    assert.equal(fs.readFileSync(victim, 'utf8'), '{"keep":true}\n');
    assert.deepEqual(fs.readdirSync(s.outside), ['victim.json']);
    assert.throws(() => getAdapter(id).uninstall(s.opts), /Refusing to write/);
  });

  test(id + ': project install refuses a config folder that is a symlink outside', (t) => {
    const s = setup(t);
    const top = rel.split('/')[0];
    if (!link(t, s.outside, path.join(s.project, top))) return;
    assert.throws(() => getAdapter(id).install(s.opts), /Refusing to write .*outside the project/);
    assert.deepEqual(fs.readdirSync(s.outside), []);
  });

  test(id + ': project install refuses a dangling symlink and creates nothing outside', (t) => {
    const s = setup(t);
    const missing = path.join(s.outside, 'new', 'created.json');
    if (!link(t, missing, path.join(s.project, rel))) return;
    assert.throws(() => getAdapter(id).install(s.opts), /Refusing to write/);
    assert.deepEqual(fs.readdirSync(s.outside), []);
  });

  test(id + ': a normal project install still works', (t) => {
    const s = setup(t);
    getAdapter(id).install(s.opts);
    assert.ok(fs.existsSync(path.join(s.project, rel)));
  });
}

test('claude-code: project install refuses a .mcp.json symlink outside before writing anything', (t) => {
  const s = setup(t);
  const victim = path.join(s.outside, 'mcp.json');
  fs.writeFileSync(victim, '{"mcpServers":{}}\n');
  if (!link(t, victim, path.join(s.project, '.mcp.json'))) return;
  const opts = { ...s.opts, mcp: true, claudeBin: '' };
  assert.throws(() => getAdapter('claude-code').install(opts), /Refusing to write .*\.mcp\.json/);
  assert.equal(fs.readFileSync(victim, 'utf8'), '{"mcpServers":{}}\n');
  assert.equal(fs.existsSync(path.join(s.project, '.claude', 'settings.json')), false);
});

test('user scope still writes through a symlinked config file inside the home folder', (t) => {
  const s = setup(t);
  const real = path.join(s.home, 'dotfiles', 'hooks.json');
  fs.mkdirSync(path.dirname(real), { recursive: true });
  fs.writeFileSync(real, '{}\n');
  if (!link(t, real, path.join(s.home, '.cursor', 'hooks.json'))) return;
  getAdapter('cursor').install({ scope: 'user', home: s.home, env: { HOME: s.home, ZN_HOME: path.join(s.home, '.zn') }, mcp: false });
  assert.ok(fs.lstatSync(path.join(s.home, '.cursor', 'hooks.json')).isSymbolicLink());
  assert.match(fs.readFileSync(real, 'utf8'), /zn-hook-cursor/);
});

test('writeFileAtomic does not follow a symlink planted at the old predictable temp name', (t) => {
  const s = setup(t);
  const victim = path.join(s.outside, 'victim.txt');
  fs.writeFileSync(victim, 'precious');
  const target = path.join(s.project, 'conf.json');
  const old = path.join(s.project, '.conf.json.' + process.pid + '.zn-tmp');
  if (!link(t, victim, old)) return;
  writeFileAtomic(target, 'new content\n', 0o644);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'precious');
  assert.equal(fs.readFileSync(target, 'utf8'), 'new content\n');
});

test('writeFileAtomic uses a different temp name each time and leaves none behind on failure', (t) => {
  const s = setup(t);
  const names = new Set();
  const realWrite = fs.writeFileSync;
  fs.writeFileSync = function (file, ...rest) {
    if (/\.zn-tmp$/.test(String(file))) names.add(path.basename(String(file)));
    return realWrite.call(this, file, ...rest);
  };
  t.after(() => { fs.writeFileSync = realWrite; });
  const dirTarget = path.join(s.project, 'adir');
  fs.mkdirSync(dirTarget);
  for (let i = 0; i < 3; i++) assert.throws(() => writeFileAtomic(dirTarget, 'x'));
  assert.equal(names.size, 3);
  assert.deepEqual(fs.readdirSync(s.project), ['adir']);
});

test('writeFileAtomic keeps the mode it is given', { skip: process.platform === 'win32' }, (t) => {
  const s = setup(t);
  const f = path.join(s.project, 'run.sh');
  const old = process.umask(0o022);
  try { writeFileAtomic(f, '#!/bin/sh\n', 0o755); } finally { process.umask(old); }
  assert.equal(fs.statSync(f).mode & 0o777, 0o755);
});
