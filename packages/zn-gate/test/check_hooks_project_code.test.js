'use strict';

// zn-gate check --hooks: a hook whose Node.js or runner.js is a file inside the project (the folder check runs in) is
// BROKEN, under the same outside-the-project rule audit applies. A zn-gate installed outside the project stays OK.
// Values are temporary folders and empty stand-in files; no hook is run.

process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const check = require('../lib/check');
const { listHooks } = require('../lib/hooks-list');
const { tempDir } = require('./helpers/tmp');

const { parseCommand } = check._internal;

// A project: a folder with its own .git, which check reads as the repository.
function project(t) {
  const dir = tempDir(t, 'zn-hooks-proj-');
  fs.mkdirSync(path.join(dir, '.git'));
  return dir;
}

// A zn-gate package under `root` (package.json named zn-gate, lib/hooks/runner.js); returns the runner path.
function zngate(root) {
  const pkg = path.join(root, 'node_modules', 'zn-gate');
  fs.mkdirSync(path.join(pkg, 'lib', 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'zn-gate', version: '0.0.0' }));
  const runner = path.join(pkg, 'lib', 'hooks', 'runner.js');
  fs.writeFileSync(runner, '// stand-in, never run\n');
  return runner;
}

// An empty file named node under `dir`; returns its path.
function fakeNode(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'node');
  fs.writeFileSync(f, '');
  return f;
}

const hookCommand = (node, runner, agent) => '"' + node + '" "' + runner + '" ' + agent;

test('a Node.js and runner installed outside the project are recognised with no inside flag', (t) => {
  const proj = project(t);
  const outside = tempDir(t, 'zn-hooks-outside-');
  const node = fakeNode(path.join(outside, 'bin'));
  const runner = zngate(outside);
  const p = parseCommand(hookCommand(node, runner, 'claude-code'), 'claude-code', proj);
  assert.ok(p, 'recognised as zn\'s hook');
  assert.equal(p.inside, undefined);
  assert.equal(p.node, fs.realpathSync(node));
  assert.equal(p.runner, fs.realpathSync(runner));
});

test('a Node.js inside the project is reported as inside the project', (t) => {
  const proj = project(t);
  const node = fakeNode(path.join(proj, 'bin'));
  const runner = zngate(tempDir(t, 'zn-hooks-outside-'));
  const p = parseCommand(hookCommand(node, runner, 'claude-code'), 'claude-code', proj);
  assert.ok(p, 'recognised as zn\'s hook');
  assert.deepEqual(p.inside, { node: true, runner: false });
});

test('a runner.js inside the project is reported as inside the project', (t) => {
  const proj = project(t);
  const runner = zngate(proj);
  const node = fakeNode(tempDir(t, 'zn-hooks-outside-'));
  const p = parseCommand(hookCommand(node, runner, 'claude-code'), 'claude-code', proj);
  assert.ok(p, 'recognised as zn\'s hook');
  assert.deepEqual(p.inside, { node: false, runner: true });
});

test('a link outside the project that points to a runner inside it is reported as inside the project', { skip: process.platform === 'win32' && 'symbolic links need an extra Windows permission' }, (t) => {
  const proj = project(t);
  const runnerInside = zngate(proj);
  const outside = tempDir(t, 'zn-hooks-outside-');
  const linkDir = path.join(outside, 'node_modules', 'zn-gate', 'lib', 'hooks');
  fs.mkdirSync(linkDir, { recursive: true });
  const link = path.join(linkDir, 'runner.js');
  fs.symlinkSync(runnerInside, link);
  const node = fakeNode(path.join(outside, 'bin'));
  const p = parseCommand(hookCommand(node, link, 'claude-code'), 'claude-code', proj);
  assert.ok(p, 'recognised as zn\'s hook');
  assert.deepEqual(p.inside, { node: false, runner: true });
});

test('check --hooks reports a project hook with a Node.js inside the project as BROKEN, with the reason', (t) => {
  const proj = project(t);
  const runner = zngate(tempDir(t, 'zn-hooks-outside-'));
  const node = fakeNode(path.join(proj, 'bin'));
  const cmd = hookCommand(node, runner, 'claude-code');
  fs.mkdirSync(path.join(proj, '.claude'));
  fs.writeFileSync(path.join(proj, '.claude', 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', command: cmd }] }] } }));
  const home = tempDir(t, 'zn-hooks-proj-home-');
  const res = listHooks({ home, env: { HOME: home, USERPROFILE: home, PATH: process.env.PATH }, cwd: proj });
  const rows = res.agents.filter((a) => a.id === 'claude-code').flatMap((a) => a.files.flatMap((f) => f.rows));
  const row = rows.find((r) => r.command === cmd);
  assert.ok(row, 'the project hook is listed: ' + JSON.stringify(rows.map((r) => r.command)));
  assert.equal(row.status, 'BROKEN');
  assert.match(row.reason, /its hook runs Node\.js from inside this project/);
});
