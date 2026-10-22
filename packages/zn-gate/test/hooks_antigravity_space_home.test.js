'use strict';
process.env.ZN_STATS = 'off';
// Antigravity runs a hook command split on spaces with no shell and no quotes: a home folder with a space in its
// path cannot hold the launcher. Install refuses (or uses ZN_HOOK_DIR) and check never calls such a hook OK.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { getAdapter } = require('../lib/agents');
const { check, report } = require('../lib/check');
const { tempDir } = require('./helpers/tmp');

const agy = getAdapter('antigravity');
const RUNNER = path.join(__dirname, '..', 'lib', 'hooks', 'runner.js');
const skip = { skip: process.platform === 'win32' };
const hooksPath = (home) => path.join(home, '.gemini', 'config', 'hooks.json');
const cmdOf = (home) => JSON.parse(fs.readFileSync(hooksPath(home), 'utf8'))['zn-gate'].PreToolUse[0].hooks[0].command;
const naive = (command, input) => {
  const parts = command.split(' ');
  return spawnSync(parts[0], parts.slice(1), { input, encoding: 'utf8' });
};
function spacedHome(t) {
  const home = path.join(tempDir(t, 'zn-agy-sp-'), 'Jose Perez');
  fs.mkdirSync(home, { recursive: true });
  return home;
}
const base = (home, extra = {}) => ({ scope: 'user', home, env: {}, nodePath: process.execPath, runnerPath: RUNNER, ...extra });

test('home with a space: install refuses with a plain message and writes nothing', skip, (t) => {
  const home = spacedHome(t);
  assert.throws(() => agy.install(base(home)), /split(ting)? the command on spaces|ZN_HOOK_DIR/);
  assert.equal(fs.existsSync(hooksPath(home)), false);
  assert.equal(fs.existsSync(path.join(home, '.zn')), false);
});

test('home with a space: ZN_HOOK_DIR with no spaces gives a command that runs when split on spaces', skip, (t) => {
  const home = spacedHome(t);
  const dir = path.join(tempDir(t, 'zn-agy-hd-'), 'hooks');
  agy.install(base(home, { env: { ZN_HOOK_DIR: dir } }));
  const c = cmdOf(home);
  assert.match(c, /^[^'"\s]+\/zn-hook-antigravity\.sh PreToolUse$/);
  assert.ok(c.startsWith(dir));
  const r = naive(c, JSON.stringify({ conversationId: 'c', workspacePaths: [home], toolCall: { name: 'list_dir', args: { DirectoryPath: home } } }));
  assert.equal(r.error, undefined);
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).decision, 'allow');
});

test('home with a space: check reports a hook written as the old fallback or with a spaced path, and passes with ZN_HOOK_DIR', skip, async (t) => {
  const home = spacedHome(t);
  const cwd = tempDir(t, 'zn-agy-cwd-');
  const env = { HOME: home, PATH: process.env.PATH };
  const file = hooksPath(home);
  const write = (command) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ 'zn-gate': { enabled: true, PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command, timeout: 15 }] }] } }));
  };
  const spacedRunner = path.join(home, 'runner.js');
  fs.writeFileSync(spacedRunner, fs.readFileSync(RUNNER));
  // what an older zn-gate wrote: the single-quoted node and runner command
  write("'" + process.execPath + "' '" + spacedRunner + "' antigravity");
  let res = await check({ home, env, cwd, nodeVersion: '22.0.0' });
  let r = res.results.find((x) => x.id === 'antigravity');
  assert.notEqual(r.state, 'protected');
  assert.notEqual(r.verified, true);
  // a launcher whose path has a space, unquoted
  const launcherDir = path.join(home, '.zn', 'hooks');
  fs.mkdirSync(launcherDir, { recursive: true });
  const l = path.join(launcherDir, 'zn-hook-antigravity.sh');
  fs.writeFileSync(l, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  write(l + ' PreToolUse');
  res = await check({ home, env, cwd, nodeVersion: '22.0.0' });
  r = res.results.find((x) => x.id === 'antigravity');
  assert.equal(r.state, 'not-protected', r.problem);
  let s = '';
  report(res, (x) => { s += x; });
  assert.match(s, /ZN_HOOK_DIR/);
  // the install that works
  const dir = path.join(tempDir(t, 'zn-agy-hd-'), 'hooks');
  agy.install(base(home, { env: { ZN_HOOK_DIR: dir } }));
  res = await check({ home, env, cwd, nodeVersion: '22.0.0' });
  r = res.results.find((x) => x.id === 'antigravity');
  assert.equal(r.state, 'protected', r.problem);
  assert.equal(r.verified, true);
});

test('home without a space is unchanged: launcher under ~/.zn/hooks, no refusal', skip, (t) => {
  const home = tempDir(t, 'zn-agy-ns-');
  agy.install(base(home));
  assert.ok(cmdOf(home).startsWith(path.join(home, '.zn', 'hooks')));
});
