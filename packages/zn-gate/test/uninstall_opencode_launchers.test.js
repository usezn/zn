'use strict';

// B-912 and B-915: zn-gate uninstall finds and removes the user and project OpenCode plugin that zn wrote
// (and only that one), and neither `zn-gate uninstall` nor `zn hooks uninstall <agent>` leaves the launcher
// scripts of zn behind. Everything runs in temporary folders.

process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { getAdapter } = require('../lib/agents');
const { dispatch } = require('../lib/broker/cli');
const { tempDir } = require('./helpers/tmp');

const RUNNER = path.join(__dirname, '..', 'lib', 'hooks', 'runner.js');

function machine(t) {
  const home = tempDir(t, 'zn-ocl-home-');
  const cwd = tempDir(t, 'zn-ocl-cwd-');
  return { home, cwd, env: { HOME: home, USERPROFILE: home, PATH: '' } };
}

function io(m, extra = {}) {
  let out = '';
  let err = '';
  const o = {
    stdout: { write: (s) => { out += s; } },
    stderr: { write: (s) => { err += s; } },
    stdin: { isTTY: true },
    env: m.env, home: m.home, cwd: m.cwd, human: true, claude: null, ancestry: () => null,
    envList: [],
    confirm: async () => true,
    ...extra,
  };
  return { o, out: () => out, err: () => err };
}

const install = (m, id, scope = 'user') => getAdapter(id).install({
  scope, projectDir: m.cwd, home: m.home, env: m.env, nodePath: process.execPath, runnerPath: RUNNER, mcp: false,
});

const userPlugin = (m) => path.join(m.home, '.config', 'opencode', 'plugins', 'zn-gate.js');
const projectPlugin = (m) => path.join(m.cwd, '.opencode', 'plugins', 'zn-gate.js');
const hooksDir = (m) => path.join(m.home, '.zn', 'hooks');
const launcherOf = (m, id) => path.join(hooksDir(m), 'zn-hook-' + id + '.sh');

test('uninstall: the plan lists the user OpenCode plugin and the run removes it, keeping a plugin of someone else', async (t) => {
  const m = machine(t);
  install(m, 'opencode');
  const foreign = path.join(m.home, '.config', 'opencode', 'plugins', 'my-own-plugin.js');
  fs.writeFileSync(foreign, 'export const Mine = async () => ({});\n');
  const dry = io(m);
  assert.equal(await dispatch('uninstall', ['--dry-run'], dry.o), 0);
  assert.match(dry.out(), /OpenCode/);
  assert.ok(dry.out().includes(userPlugin(m)), dry.out());
  assert.ok(fs.existsSync(userPlugin(m)), 'a dry run changes nothing');
  const c = io(m);
  assert.equal(await dispatch('uninstall', [], c.o), 0, c.out());
  assert.equal(fs.existsSync(userPlugin(m)), false, 'the plugin is gone');
  assert.equal(fs.readFileSync(foreign, 'utf8'), 'export const Mine = async () => ({});\n', 'a foreign plugin stays');
  assert.match(c.out(), /OpenCode: removed/);
});

test('uninstall: a project OpenCode plugin is listed and removed as well', async (t) => {
  const m = machine(t);
  install(m, 'opencode', 'project');
  const c = io(m);
  assert.equal(await dispatch('uninstall', ['--dry-run'], c.o), 0);
  assert.ok(c.out().includes(projectPlugin(m)), c.out());
  const r = io(m);
  assert.equal(await dispatch('uninstall', [], r.o), 0, r.out());
  assert.equal(fs.existsSync(projectPlugin(m)), false);
});

test('uninstall: a file named zn-gate.js that zn did not write is not listed and is left alone', async (t) => {
  const m = machine(t);
  fs.mkdirSync(path.dirname(userPlugin(m)), { recursive: true });
  const text = '// my plugin that mentions "hook", "opencode" and /zn-gate/lib/hooks/runner.js"\nexport const X = async () => ({});\n';
  fs.writeFileSync(userPlugin(m), text);
  const c = io(m);
  assert.equal(await dispatch('uninstall', [], c.o), 0, c.out());
  assert.match(c.out(), /Nothing from zn-gate was found/);
  assert.equal(fs.readFileSync(userPlugin(m), 'utf8'), text);
});

test('uninstall: the launcher scripts of every agent and the empty folder are removed', async (t) => {
  const m = machine(t);
  for (const d of ['.claude', '.codex', '.cursor', '.gemini']) fs.mkdirSync(path.join(m.home, d), { recursive: true });
  for (const id of ['claude-code', 'codex', 'cursor', 'gemini']) install(m, id);
  assert.ok(fs.readdirSync(hooksDir(m)).length >= 4);
  const dry = io(m);
  assert.equal(await dispatch('uninstall', ['--dry-run'], dry.o), 0);
  assert.ok(dry.out().includes(launcherOf(m, 'codex')), dry.out());
  const c = io(m);
  assert.equal(await dispatch('uninstall', [], c.o), 0, c.out());
  assert.equal(fs.existsSync(hooksDir(m)), false, 'the empty hooks folder is removed');
});

test('uninstall: files in the hooks folder that zn did not write stay, and so does the folder', async (t) => {
  const m = machine(t);
  fs.mkdirSync(path.join(m.home, '.codex'), { recursive: true });
  install(m, 'codex');
  const mine = path.join(hooksDir(m), 'my-notes.txt');
  const lookalike = launcherOf(m, 'gemini');
  fs.writeFileSync(mine, 'keep\n');
  fs.writeFileSync(lookalike, '#!/bin/sh\necho mine\n');
  const c = io(m);
  assert.equal(await dispatch('uninstall', [], c.o), 0, c.out());
  assert.equal(fs.existsSync(launcherOf(m, 'codex')), false);
  assert.equal(fs.readFileSync(mine, 'utf8'), 'keep\n');
  assert.equal(fs.readFileSync(lookalike, 'utf8'), '#!/bin/sh\necho mine\n');
});

test('uninstall: a launcher left behind with no hooks pointing to it is removed too', async (t) => {
  const m = machine(t);
  fs.mkdirSync(path.join(m.home, '.codex'), { recursive: true });
  install(m, 'codex');
  fs.unlinkSync(path.join(m.home, '.codex', 'hooks.json'));
  assert.ok(fs.existsSync(launcherOf(m, 'codex')));
  const c = io(m);
  assert.equal(await dispatch('uninstall', [], c.o), 0, c.out());
  assert.equal(fs.existsSync(hooksDir(m)), false);
});

test('hooks uninstall <agent> removes that agent launcher and the empty folder, not the launcher of another agent', async (t) => {
  const m = machine(t);
  for (const d of ['.codex', '.gemini']) fs.mkdirSync(path.join(m.home, d), { recursive: true });
  install(m, 'codex');
  install(m, 'gemini');
  const a = io(m);
  assert.equal(await dispatch('hooks', ['uninstall', 'codex'], a.o), 0, a.err());
  assert.equal(fs.existsSync(launcherOf(m, 'codex')), false);
  assert.ok(fs.existsSync(launcherOf(m, 'gemini')), 'the launcher of another agent stays');
  const b = io(m);
  assert.equal(await dispatch('hooks', ['uninstall', 'gemini'], b.o), 0, b.err());
  assert.equal(fs.existsSync(hooksDir(m)), false, 'the empty folder goes with the last launcher');
});

test('hooks uninstall removes a launcher left behind when the hooks are already gone', async (t) => {
  const m = machine(t);
  fs.mkdirSync(path.join(m.home, '.codex'), { recursive: true });
  install(m, 'codex');
  fs.unlinkSync(path.join(m.home, '.codex', 'hooks.json'));
  const a = io(m);
  assert.equal(await dispatch('hooks', ['uninstall', 'codex'], a.o), 0, a.err());
  assert.equal(fs.existsSync(hooksDir(m)), false);
});

test('hooks uninstall opencode removes the user plugin and keeps a foreign one', async (t) => {
  const m = machine(t);
  install(m, 'opencode');
  const foreign = path.join(path.dirname(userPlugin(m)), 'other.js');
  fs.writeFileSync(foreign, 'export const O = async () => ({});\n');
  const a = io(m);
  assert.equal(await dispatch('hooks', ['uninstall', 'opencode'], a.o), 0, a.err());
  assert.equal(fs.existsSync(userPlugin(m)), false);
  assert.ok(fs.existsSync(foreign));
});

test('hooks uninstall of a project leaves the user launcher alone', async (t) => {
  const m = machine(t);
  fs.mkdirSync(path.join(m.home, '.codex'), { recursive: true });
  install(m, 'codex');
  install(m, 'codex', 'project');
  const a = io(m);
  assert.equal(await dispatch('hooks', ['uninstall', 'codex', '--project'], a.o), 0, a.err());
  assert.ok(fs.existsSync(launcherOf(m, 'codex')));
});
