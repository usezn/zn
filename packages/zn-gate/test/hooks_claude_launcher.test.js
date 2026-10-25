'use strict';

// zn hooks install claude-code: the hook command goes through a launcher that still
// blocks when the Node.js it was installed with is gone. Claude Code treats a hook
// that cannot start (exit 127) as a non-blocking error and runs the call, so the
// launcher must not depend on Node.js to block. Values are fake. Everything runs
// in a temporary home: nothing is written to the real ~/.zn or ~/.claude.

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

const claude = getAdapter('claude-code');
const RUNNER = path.resolve(__dirname, '..', 'lib', 'hooks', 'runner.js');
const posix = process.platform !== 'win32';
const GONE = '/nonexistent/node-gone/bin/node';
const REINSTALL = 'install zn-gate again for the Node.js you use now: run `npm install -g zn-gate`, then `zn hooks install claude-code`, in your own terminal';
const EVENTS = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'UserPromptExpansion'];

function setup(t, nodePath) {
  const home = tempDir(t, 'zn-b95-');
  const env = { HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), ZN_HOME: path.join(home, '.zn'), PATH: process.env.PATH };
  claude.install({ env, home, nodePath, runnerPath: RUNNER, mcp: false });
  const data = JSON.parse(fs.readFileSync(claude.settingsFile({ env, home }), 'utf8'));
  return { home, env, data, file: launcher.launcherFile('claude-code', { env, home }) };
}

function emptyBin(t) { return tempDir(t, 'zn-b95-bin-'); }

function runLauncher(file, event, input, pathValue) {
  return spawnSync('/bin/sh', [file, event], { input, encoding: 'utf8', env: { PATH: pathValue, HOME: '/nonexistent' } });
}

function breakNode(file) {
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^ZN_NODE=.*$/m, "ZN_NODE='" + GONE + "'"));
}

test('claude-code install: a user install writes the launcher and one command per event', { skip: !posix }, (t) => {
  const { data, file, home } = setup(t, process.execPath);
  assert.ok(file.startsWith(path.join(home, '.zn', 'hooks')), 'the launcher stays inside the temporary home');
  assert.equal(fs.statSync(file).mode & 0o777, 0o755);
  for (const ev of EVENTS) {
    const h = data.hooks[ev][0].hooks[0];
    assert.equal(h.command, "'" + file + "' " + ev);
    assert.ok(cfg.isOurs(h.command, 'claude-code'), ev + ' is recognized as zn\'s');
  }
  // A call or a prompt is blocked when the hook cannot start (Claude Code 2.1.295 and later); the post hook only warns.
  assert.equal(data.hooks.PreToolUse[0].hooks[0].onFailure, 'block');
  assert.equal(data.hooks.UserPromptSubmit[0].hooks[0].onFailure, 'block');
  assert.equal(data.hooks.UserPromptExpansion[0].hooks[0].onFailure, 'block');
  assert.equal(data.hooks.PostToolUse[0].hooks[0].onFailure, undefined);
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.includes("\nZN_NODE='" + process.execPath + "'\n"));
  assert.match(text, /^ZN_RUNNER='.*runner\.js'$/m);
});

test('claude-code launcher: with the recorded Node.js it runs the real hook and denies .env', { skip: !posix }, (t) => {
  const { file } = setup(t, process.execPath);
  const dir = tempDir(t, 'zn-b95-proj-');
  fs.writeFileSync(path.join(dir, '.env'), 'API_KEY=sk-test-EXAMPLE0000000000000000\n');
  const ev = { hook_event_name: 'PreToolUse', session_id: 's', cwd: dir, tool_name: 'Bash', tool_input: { command: 'cat .env' } };
  const r = runLauncher(file, 'PreToolUse', JSON.stringify(ev), process.env.PATH);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /"permissionDecision":\s*"deny"/);
});

test('claude-code launcher: Node.js gone and no zn on PATH: PreToolUse and the prompt events block with exit 2', { skip: !posix }, (t) => {
  const { file } = setup(t, GONE);
  const bin = emptyBin(t);
  for (const ev of ['PreToolUse', 'UserPromptSubmit', 'UserPromptExpansion']) {
    const r = runLauncher(file, ev, '{}', bin);
    assert.equal(r.status, 2, ev + ' exits 2 (Claude Code: exit code 2 blocks, stderr is the reason)');
    assert.match(r.stderr, /zn: its hook cannot start/);
    assert.match(r.stderr, /zn hooks install claude-code/);
    assert.doesNotMatch(r.stderr, /No such file|missing/, 'Claude Code treats an exit 2 that says a file is missing as non-blocking in some events');
    assert.equal(r.stdout, '');
  }
  // PostToolUse: the tool already ran, so it only warns the user.
  const post = runLauncher(file, 'PostToolUse', '{}', bin);
  assert.equal(post.status, 0);
  assert.match(JSON.parse(post.stdout).systemMessage, /NOT protecting this session.*zn hooks install claude-code/);
});

test('claude-code launcher: recorded Node.js gone but zn and node on an absolute PATH: runs zn hook', { skip: !posix }, (t) => {
  const { file } = setup(t, GONE);
  const bin = tempDir(t, 'zn-b95-bin-');
  fs.writeFileSync(path.join(bin, 'node'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'zn'), '#!/bin/sh\necho "VIA_ZN $*"\nprintf ok > "$ZN_HOOK_ACK"\n', { mode: 0o755 });
  const r = runLauncher(file, 'PreToolUse', '{}', bin);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), 'VIA_ZN hook claude-code');
});

test('claude-code: reinstall replaces the launcher, uninstall removes it; a project install writes none', { skip: !posix }, (t) => {
  const { env, home, file, data } = setup(t, process.execPath);
  assert.equal(data.hooks.PreToolUse.length, 1);
  claude.install({ env, home, nodePath: GONE, runnerPath: RUNNER, mcp: false });
  assert.match(fs.readFileSync(file, 'utf8'), /^ZN_NODE='\/nonexistent\/node-gone\/bin\/node'$/m);
  const again = JSON.parse(fs.readFileSync(claude.settingsFile({ env, home }), 'utf8'));
  assert.equal(again.hooks.PreToolUse.length, 1, 'install is idempotent');
  claude.uninstall({ env, home, mcp: false });
  assert.equal(fs.existsSync(file), true, 'a single uninstall keeps the shared launcher');
  claude.install({ env, home, nodePath: process.execPath, runnerPath: RUNNER, mcp: false });
  claude.uninstall({ env, home, mcp: false, removeLauncher: true });
  assert.equal(fs.existsSync(file), false);
  const proj = tempDir(t, 'zn-b95-proj-');
  claude.install({ scope: 'project', projectDir: proj, env, home, nodePath: process.execPath, runnerPath: RUNNER, mcp: false });
  const pd = JSON.parse(fs.readFileSync(path.join(proj, '.claude', 'settings.json'), 'utf8'));
  assert.ok(launcher.isProjectGuard(pd.hooks.PreToolUse[0].hooks[0].command, 'claude-code'));
  assert.equal(fs.existsSync(file), false);
});

test('claude-code windows: the launcher path is written with forward slashes for Git Bash', () => {
  const cmd = launcher.launcherCommand('C:\\Users\\a b\\.zn\\hooks\\zn-hook-claude-code.sh', 'PreToolUse', 'win32');
  assert.equal(cmd, "'C:/Users/a b/.zn/hooks/zn-hook-claude-code.sh' PreToolUse");
  assert.ok(cfg.isOurs(cmd, 'claude-code'));
});

test('check: the Node.js recorded in the launcher is gone and nothing else can run the hook: not protected', { skip: !posix }, async (t) => {
  const { home, env, file } = setup(t, process.execPath);
  breakNode(file);
  const r = (await check({ home, env: { ...env, PATH: emptyBin(t) }, cwd: tempDir(t, 'zn-b95-cwd-') })).results.find((x) => x.id === 'claude-code');
  assert.equal(r.state, 'not-protected');
  assert.match(r.problem, /Node\.js \(\/nonexistent\/node-gone\/bin\/node\) is no longer there, so zn now blocks the tool calls/);
  assert.equal(r.fix, REINSTALL);
});

test('check: the recorded Node.js is gone but zn and node are on the PATH: protected, with a note to reinstall', { skip: !posix }, async (t) => {
  const { home, env, file } = setup(t, process.execPath);
  breakNode(file);
  const bin = tempDir(t, 'zn-b95-bin-');
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  fs.writeFileSync(path.join(bin, 'zn'), '#!/bin/sh\nexec "' + process.execPath + '" "' + RUNNER + '" "$2"\n', { mode: 0o755 });
  const r = (await check({ home, env: { ...env, PATH: bin }, cwd: tempDir(t, 'zn-b95-cwd-') })).results.find((x) => x.id === 'claude-code');
  assert.equal(r.state, 'protected', r.problem);
  assert.ok(r.notes.some((n) => /now runs `zn` from your PATH.*zn hooks install claude-code/.test(n)));
});

test('check: a launcher script that was deleted is reported', { skip: !posix }, async (t) => {
  const { home, env, file } = setup(t, process.execPath);
  fs.unlinkSync(file);
  const r = (await check({ home, env, cwd: tempDir(t, 'zn-b95-cwd-') })).results.find((x) => x.id === 'claude-code');
  assert.equal(r.state, 'not-protected');
  assert.match(r.problem, /launcher script .* is missing or was changed/);
});
