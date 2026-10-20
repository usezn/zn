'use strict';

// zn hooks install cursor | gemini: the hook command goes through the launcher, so a Node.js that is gone
// blocks (exit 2, documented by both agents) instead of letting the call run (both fail open when a hook
// fails). Antigravity documents nothing about hook failures: it keeps the plain command, and `check`
// reports the missing Node.js. Values are fake. Everything runs in a temporary home.

process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { getAdapter } = require('../lib/agents');
const cfg = require('../lib/agents/config-file');
const launcher = require('../lib/agents/launcher');
const { check } = require('../lib/check');
const { tempDir } = require('./helpers/tmp');

const RUNNER = path.resolve(__dirname, '..', 'lib', 'hooks', 'runner.js');
const posix = process.platform !== 'win32';
const GONE = '/nonexistent/node-gone/bin/node';
const reinstall = (id) => 'install zn-gate again for the Node.js you use now: run `npm install -g zn-gate`, then `zn hooks install ' + id + '`, in your own terminal';

function setup(t, id, nodePath) {
  const home = tempDir(t, 'zn-b96-');
  const env = { HOME: home, ZN_HOME: path.join(home, '.zn'), PATH: process.env.PATH };
  const adapter = getAdapter(id);
  adapter.install({ env, home, nodePath, runnerPath: RUNNER, mcp: false });
  return { home, env, adapter, file: launcher.launcherFile(id, { env, home }) };
}

function run(file, event, pathValue) {
  return spawnSync('/bin/sh', [file, event], { input: '{}', encoding: 'utf8', env: { PATH: pathValue, HOME: '/nonexistent' } });
}

const stateOf = async (t, ctx, id, pathValue) =>
  (await check({ home: ctx.home, env: { ...ctx.env, PATH: pathValue }, cwd: tempDir(t, 'zn-b96-cwd-') })).results.find((x) => x.id === id);

test('cursor: user install writes the launcher; the events that can deny block, postToolUse only warns', { skip: !posix }, (t) => {
  const { home, env, adapter, file } = setup(t, 'cursor', GONE);
  assert.ok(file.startsWith(path.join(home, '.zn', 'hooks')));
  const data = JSON.parse(fs.readFileSync(adapter.hooksFile({ env, home }), 'utf8'));
  for (const ev of adapter.EVENTS) {
    const h = data.hooks[ev][0];
    assert.equal(h.command, "'" + file + "' " + ev);
    assert.ok(cfg.isOurs(h.command, 'cursor'));
  }
  assert.equal(data.hooks.beforeReadFile[0].failClosed, true, 'failClosed stays');
  const bin = tempDir(t, 'zn-b96-bin-');
  for (const ev of ['beforeMCPExecution', 'beforeReadFile', 'beforeShellExecution', 'beforeSubmitPrompt', 'preToolUse']) {
    const r = run(file, ev, bin);
    assert.equal(r.status, 2, ev);
    assert.match(r.stderr, /zn hooks install cursor/);
    assert.equal(r.stdout, '');
  }
  const post = run(file, 'postToolUse', bin);
  assert.equal(post.status, 0);
  assert.match(post.stderr, /NOT protecting this session.*zn hooks install cursor/);
  assert.equal(post.stdout, '');
});

test('cursor: with the recorded Node.js the launcher runs the real hook', { skip: !posix }, (t) => {
  const { file } = setup(t, 'cursor', process.execPath);
  const dir = tempDir(t, 'zn-b96-proj-');
  fs.writeFileSync(path.join(dir, '.env'), 'API_KEY=sk-test-EXAMPLE0000000000000000\n');
  const r = spawnSync('/bin/sh', [file, 'beforeReadFile'], { input: JSON.stringify({ hook_event_name: 'beforeReadFile', cwd: dir, file_path: path.join(dir, '.env'), content: 'x', workspace_roots: [dir] }), encoding: 'utf8', env: { PATH: process.env.PATH, HOME: '/nonexistent' } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /"permission":\s*"deny"/);
});

test('cursor: uninstall removes the launcher; a project install writes none', { skip: !posix }, (t) => {
  const { env, home, adapter, file } = setup(t, 'cursor', process.execPath);
  assert.ok(fs.existsSync(file));
  adapter.uninstall({ env, home });
  assert.equal(fs.existsSync(file), false);
  const proj = tempDir(t, 'zn-b96-proj-');
  adapter.install({ scope: 'project', projectDir: proj, env, home, nodePath: process.execPath, runnerPath: RUNNER });
  assert.match(JSON.parse(fs.readFileSync(path.join(proj, '.cursor', 'hooks.json'), 'utf8')).hooks.preToolUse[0].command, / cursor$/);
  assert.equal(fs.existsSync(file), false);
});

test('cursor: check reports the Node.js that is gone with the reinstall fix', { skip: !posix }, async (t) => {
  const ctx = setup(t, 'cursor', process.execPath);
  fs.writeFileSync(ctx.file, fs.readFileSync(ctx.file, 'utf8').replace(/^ZN_NODE=.*$/m, "ZN_NODE='" + GONE + "'"));
  const r = await stateOf(t, ctx, 'cursor', tempDir(t, 'zn-b96-bin-'));
  assert.equal(r.state, 'not-protected');
  assert.match(r.problem, /Node\.js \(\/nonexistent\/node-gone\/bin\/node\) is no longer there/);
  assert.equal(r.fix, reinstall('cursor'));
});

test('cursor windows: each event is an inline PowerShell script that blocks with exit 2', (t) => {
  const home = tempDir(t, 'zn-b96-win-');
  const adapter = getAdapter('cursor');
  adapter.install({ home, env: { HOME: home, ZN_HOME: path.join(home, '.zn') }, platform: 'win32', nodePath: 'C:\\n\\node.exe', runnerPath: 'C:\\z\\runner.js' });
  const data = JSON.parse(fs.readFileSync(adapter.hooksFile({ home }), 'utf8'));
  const script = (ev) => require('../lib/shell-quote').windowsCommandScript(data.hooks[ev][0].command);
  assert.match(script('beforeShellExecution'), /Error\.WriteLine\(.*\); exit 2 # zn hook cursor$/);
  assert.match(script('postToolUse'), /exit 0 # zn hook cursor$/);
  assert.ok(cfg.isOurs(data.hooks.preToolUse[0].command, 'cursor'));
  assert.equal(fs.existsSync(launcher.launcherFile('cursor', { home, env: { ZN_HOME: path.join(home, '.zn') } })), false);
});

test('gemini: user install writes the launcher; BeforeTool blocks with exit 2 when the Node.js is gone', { skip: !posix }, (t) => {
  const { home, env, adapter, file } = setup(t, 'gemini', GONE);
  const data = JSON.parse(fs.readFileSync(adapter.settingsFile({ env, home }), 'utf8'));
  const h = data.hooks.BeforeTool[0].hooks[0];
  assert.equal(h.command, "'" + file + "' BeforeTool");
  assert.ok(cfg.isOurs(h.command, 'gemini'));
  const r = run(file, 'BeforeTool', tempDir(t, 'zn-b96-bin-'));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /zn hooks install gemini/);
  assert.equal(r.stdout, '');
});

test('gemini: with the recorded Node.js the launcher runs the real hook', { skip: !posix }, (t) => {
  const { file } = setup(t, 'gemini', process.execPath);
  const dir = tempDir(t, 'zn-b96-proj-');
  fs.writeFileSync(path.join(dir, '.env'), 'API_KEY=sk-test-EXAMPLE0000000000000000\n');
  const ev = { hook_event_name: 'BeforeTool', session_id: 's', cwd: dir, tool_name: 'read_file', tool_input: { file_path: path.join(dir, '.env') } };
  const r = spawnSync('/bin/sh', [file, 'BeforeTool'], { input: JSON.stringify(ev), encoding: 'utf8', env: { PATH: process.env.PATH, HOME: '/nonexistent' } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /"decision":\s*"deny"/);
});

test('gemini: uninstall removes the launcher; check reports the Node.js that is gone', { skip: !posix }, async (t) => {
  const ctx = setup(t, 'gemini', process.execPath);
  fs.writeFileSync(ctx.file, fs.readFileSync(ctx.file, 'utf8').replace(/^ZN_NODE=.*$/m, "ZN_NODE='" + GONE + "'"));
  const r = await stateOf(t, ctx, 'gemini', tempDir(t, 'zn-b96-bin-'));
  assert.equal(r.state, 'not-protected');
  assert.match(r.problem, /Node\.js \(\/nonexistent\/node-gone\/bin\/node\) is no longer there/);
  assert.equal(r.fix, reinstall('gemini'));
  ctx.adapter.uninstall({ env: ctx.env, home: ctx.home });
  assert.equal(fs.existsSync(ctx.file), false);
});

test('antigravity: no launcher (the docs say nothing about hook failures); check reports a missing Node.js', { skip: !posix }, async (t) => {
  const ctx = setup(t, 'antigravity', GONE);
  assert.equal(fs.existsSync(ctx.file), false);
  const data = JSON.parse(fs.readFileSync(ctx.adapter.hooksFile({ env: ctx.env, home: ctx.home }), 'utf8'));
  assert.match(data['zn-gate'].PreToolUse[0].hooks[0].command, /node-gone\/bin\/node.* antigravity$/);
  const r = await stateOf(t, ctx, 'antigravity', tempDir(t, 'zn-b96-bin-'));
  assert.equal(r.state, 'not-protected');
  assert.match(r.problem, /its hook cannot start/);
  assert.equal(r.fix, reinstall('antigravity'));
});

test('a hook that starts and then fails is blocked, not passed through, and zn on PATH is not tried after it', { skip: !posix }, (t) => {
  const broken = path.join(tempDir(t, 'zn-b96-broken-'), 'runner.js');
  fs.writeFileSync(broken, "throw new Error('broken install');\n");
  const bin = tempDir(t, 'zn-b96-bin2-');
  const mark = path.join(bin, 'zn-ran');
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  fs.writeFileSync(path.join(bin, 'zn'), '#!/bin/sh\ntouch ' + JSON.stringify(mark) + '\nexit 0\n', { mode: 0o755 });
  for (const [id, block, warn] of [['gemini', 'BeforeTool', null], ['cursor', 'beforeShellExecution', 'postToolUse']]) {
    const home = tempDir(t, 'zn-b96-crash-');
    const env = { HOME: home, ZN_HOME: path.join(home, '.zn'), PATH: process.env.PATH };
    getAdapter(id).install({ env, home, nodePath: process.execPath, runnerPath: broken, mcp: false });
    const file = launcher.launcherFile(id, { env, home });
    const r = run(file, block, bin);
    assert.equal(r.status, 2, id + ' ' + block + ': ' + r.stderr);
    assert.match(r.stderr, /its hook failed, so this was blocked.*zn-gate check/);
    assert.equal(fs.existsSync(mark), false, 'zn on PATH must not run after the recorded hook failed');
    if (warn) {
      const w = run(file, warn, bin);
      assert.equal(w.status, 0);
      assert.match(w.stderr, /its hook failed/);
    }
  }
});

test('windows: cursor and gemini also print their deny JSON, call zn.cmd and leave early only on 0 or 2', (t) => {
  const { windowsCommandScript } = require('../lib/shell-quote');
  for (const [id, ev, deny] of [['cursor', 'beforeShellExecution', '"permission":"deny"'], ['gemini', 'BeforeTool', '"decision":"deny"']]) {
    const home = tempDir(t, 'zn-b96-win2-');
    const adapter = getAdapter(id);
    adapter.install({ home, env: { HOME: home, ZN_HOME: path.join(home, '.zn') }, platform: 'win32', nodePath: 'C:\\n\\node.exe', runnerPath: 'C:\\z\\runner.js', mcp: false });
    const data = JSON.parse(fs.readFileSync(adapter.hooksFile({ home, env: { HOME: home } }), 'utf8'));
    const groups = data.hooks[ev];
    const cmd = (groups[0].hooks ? groups[0].hooks[0] : groups[0]).command;
    const s = windowsCommandScript(cmd);
    assert.ok(s.startsWith("$ProgressPreference='SilentlyContinue';"), id);
    assert.ok(s.includes(deny), id + ' deny JSON');
    assert.ok(s.includes('& zn.cmd hook ' + id) && !/& zn hook/.test(s), id + ' zn.cmd');
    assert.ok(!/exit \$LASTEXITCODE \}/.test(s.replace(/if \(\$LASTEXITCODE -eq 0 -or \$LASTEXITCODE -eq 2\) \{ exit \$LASTEXITCODE \}/g, '')), id + ' no unconditional exit');
    assert.match(s, /exit 2 # zn hook /);
  }
});
