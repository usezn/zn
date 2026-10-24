'use strict';
process.env.ZN_STATS = 'off';
// Antigravity runs a hook command split on spaces with no shell and no quotes: a home folder with a space in its
// path cannot hold the launcher. Install refuses (or uses ZN_HOOK_DIR) and check never calls such a hook OK.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { getAdapter } = require('../lib/agents');
const { check, report } = require('../lib/check');
const { tempDir } = require('./helpers/tmp');

const agy = getAdapter('antigravity');
const RUNNER = path.join(__dirname, '..', 'lib', 'hooks', 'runner.js');
// Internal test option: the system temp folder is shared (1777), so the ancestor rule is checked only below it.
const TMP_ROOT = fs.realpathSync(os.tmpdir());
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
  agy.install(base(home, { env: { ZN_HOOK_DIR: dir }, hookDirTrustedRoot: TMP_ROOT }));
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
  agy.install(base(home, { env: { ZN_HOOK_DIR: dir }, hookDirTrustedRoot: TMP_ROOT }));
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

// ZN_HOOK_DIR names any folder and the launcher written there runs on every tool call: it must be ours and private.
// The test folders live under the system temp folder, which is shared (1777) and would fail the ancestor rule, so the
// tests tell ensureSafeHookDir (internal option, never set in production) to trust that one folder and check everything
// below it. The production rule, with no trusted folder, is tested at the end.
const hookDirInstall = (home, dir) => agy.install(base(home, { env: { ZN_HOOK_DIR: dir }, hookDirTrustedRoot: TMP_ROOT }));
const mkdirMode = (dir, mode) => { fs.mkdirSync(dir, { recursive: true }); fs.chmodSync(dir, mode); return dir; };

test('ZN_HOOK_DIR: an own folder with mode 0700 is accepted, and a new one is created 0700', skip, (t) => {
  const home = tempDir(t, 'zn-agy-ok-');
  const own = mkdirMode(path.join(tempDir(t, 'zn-agy-hd-'), 'hooks'), 0o700);
  hookDirInstall(home, own);
  assert.ok(cmdOf(home).startsWith(own));
  const fresh = path.join(tempDir(t, 'zn-agy-hd-'), 'a', 'hooks');
  hookDirInstall(home, fresh);
  assert.equal(fs.statSync(fresh).mode & 0o777, 0o700);
});

test('ZN_HOOK_DIR: a group-writable folder is refused and nothing is written', skip, (t) => {
  const home = tempDir(t, 'zn-agy-gw-');
  const dir = mkdirMode(path.join(tempDir(t, 'zn-agy-hd-'), 'hooks'), 0o770);
  assert.throws(() => hookDirInstall(home, dir), /other users can write|ZN_HOOK_DIR/);
  assert.equal(fs.existsSync(hooksPath(home)), false);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('ZN_HOOK_DIR: a world-writable folder is refused (even with the sticky bit)', skip, (t) => {
  const home = tempDir(t, 'zn-agy-ww-');
  const dir = mkdirMode(path.join(tempDir(t, 'zn-agy-hd-'), 'hooks'), 0o777);
  assert.throws(() => hookDirInstall(home, dir), /other users can write/);
  fs.chmodSync(dir, 0o1777);
  assert.throws(() => hookDirInstall(home, dir), /other users can write/);
  assert.equal(fs.existsSync(hooksPath(home)), false);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('ZN_HOOK_DIR: a link to a folder is refused, and the target is left alone', skip, (t) => {
  const home = tempDir(t, 'zn-agy-ln-');
  const root = tempDir(t, 'zn-agy-hd-');
  const target = mkdirMode(path.join(root, 'real'), 0o700);
  const link = path.join(root, 'link');
  fs.symlinkSync(target, link);
  assert.throws(() => hookDirInstall(home, link), /it is a link/);
  assert.equal(fs.existsSync(hooksPath(home)), false);
  assert.deepEqual(fs.readdirSync(target), []);
});

test('ZN_HOOK_DIR: a file in place of the folder is refused', skip, (t) => {
  const home = tempDir(t, 'zn-agy-fl-');
  const f = path.join(tempDir(t, 'zn-agy-hd-'), 'hooks');
  fs.writeFileSync(f, 'x');
  assert.throws(() => hookDirInstall(home, f), /ZN_HOOK_DIR|not a folder|EEXIST|ENOTDIR/);
  assert.equal(fs.existsSync(hooksPath(home)), false);
});

test('ZN_HOOK_DIR: the refusal also covers the other agents that write a launcher', skip, (t) => {
  const launcher = require('../lib/agents/launcher');
  const dir = mkdirMode(path.join(tempDir(t, 'zn-agy-hd-'), 'hooks'), 0o775);
  assert.throws(() => launcher.writeLauncher('codex', process.execPath, RUNNER, { env: { ZN_HOOK_DIR: dir } }), /other users can write/);
  assert.equal(fs.existsSync(path.join(dir, 'zn-hook-codex.sh')), false);
});

test('the project guard stays out of the space check: a spaced home does not stop a project install', skip, (t) => {
  const home = spacedHome(t);
  const proj = tempDir(t, 'zn-agy-pr-');
  agy.install({ scope: 'project', projectDir: proj, home, env: {} });
  assert.ok(fs.existsSync(path.join(proj, '.agents', 'hooks.json')));
});

test('check: the quotes inside the project guard are not read as a hook that cannot start', skip, async (t) => {
  const home = spacedHome(t);
  const proj = tempDir(t, 'zn-agy-pc-');
  agy.install({ scope: 'project', projectDir: proj, home, env: {} });
  const res = await check({ home, env: { HOME: home, PATH: process.env.PATH }, cwd: proj, nodeVersion: '22.0.0' });
  const r = res.results.find((x) => x.id === 'antigravity');
  assert.doesNotMatch(String(r.problem || ''), /cannot start|cut in the wrong place/);
});

test('ZN_HOOK_DIR: a new folder inside a parent that anyone can write is refused, with or without the sticky bit, and nothing is created', skip, (t) => {
  for (const mode of [0o777, 0o1777, 0o775]) {
    const home = tempDir(t, 'zn-agy-par-');
    const parent = mkdirMode(path.join(tempDir(t, 'zn-agy-hd-'), 'parent'), mode);
    const dir = path.join(parent, 'hooks');
    assert.throws(() => hookDirInstall(home, dir), /a folder above it .*can be written by other users|ZN_HOOK_DIR/, 'mode ' + mode.toString(8));
    assert.equal(fs.existsSync(dir), false);
    assert.equal(fs.existsSync(hooksPath(home)), false);
    assert.deepEqual(fs.readdirSync(parent), []);
  }
});

test('ZN_HOOK_DIR: a folder further down a parent that anyone can write is refused', skip, (t) => {
  const home = tempDir(t, 'zn-agy-par2-');
  const top = mkdirMode(path.join(tempDir(t, 'zn-agy-hd-'), 'top'), 0o700);
  fs.mkdirSync(path.join(top, 'mid'), { mode: 0o700 });
  fs.chmodSync(path.join(top, 'mid'), 0o777);
  const dir = path.join(top, 'mid', 'a', 'b', 'hooks');
  assert.throws(() => hookDirInstall(home, dir), /a folder above it .*can be written by other users/);
  assert.equal(fs.existsSync(path.join(top, 'mid', 'a')), false);
});

test('ZN_HOOK_DIR: a link anywhere in the path is refused, even when the target is a safe folder', skip, (t) => {
  const home = tempDir(t, 'zn-agy-ln2-');
  const root = tempDir(t, 'zn-agy-hd-');
  const open777 = mkdirMode(path.join(root, 'open'), 0o777);
  const own = mkdirMode(path.join(root, 'own'), 0o700);
  fs.symlinkSync(open777, path.join(own, 'link'));
  assert.throws(() => hookDirInstall(home, path.join(own, 'link', 'hooks2')), /a link is in its path/);
  assert.deepEqual(fs.readdirSync(open777), []);
  const safe = mkdirMode(path.join(root, 'safe'), 0o700);
  fs.symlinkSync(safe, path.join(own, 'link2'));
  assert.throws(() => hookDirInstall(home, path.join(own, 'link2', 'hooks')), /a link is in its path/);
  assert.deepEqual(fs.readdirSync(safe), []);
});

test('ZN_HOOK_DIR: a good chain of own folders (new folders several levels down) is accepted', skip, (t) => {
  const home = tempDir(t, 'zn-agy-good-');
  const dir = path.join(tempDir(t, 'zn-agy-hd-'), 'a', 'b', 'hooks');
  hookDirInstall(home, dir);
  assert.ok(cmdOf(home).startsWith(dir));
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
});

test('ZN_HOOK_DIR: production rule has no exception: a folder that anyone can write (sticky bit or not) is refused above the launcher folder', skip, (t) => {
  const launcher = require('../lib/agents/launcher');
  const shared = mkdirMode(path.join(tempDir(t, 'zn-agy-hd-'), 'shared'), 0o1777); // like /tmp
  const dir = path.join(shared, 'x', 'hooks');
  assert.throws(() => launcher.ensureSafeHookDir(dir, 'linux'), /a folder above it .*can be written by other users/);
  assert.equal(fs.existsSync(path.join(shared, 'x')), false);
});
