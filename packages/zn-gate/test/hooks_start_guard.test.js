'use strict';

// A hook command that cannot start (the launcher file is gone, `node` is not on the PATH) exits 127, and the
// agents run that as a non-blocking error: the call goes ahead with no message. The start guard around the hook
// command turns 127 and 126 into exit 2 with a short reason, on the events where exit 2 blocks. Everything runs
// in a temporary home with fake values: nothing is written to the real ~/.zn or any agent config.

process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { getAdapter } = require('../lib/agents');
const cfg = require('../lib/agents/config-file');
const launcher = require('../lib/agents/launcher');
const { tempDir } = require('./helpers/tmp');

const claude = getAdapter('claude-code');
const RUNNER = path.resolve(__dirname, '..', 'lib', 'hooks', 'runner.js');
const HOOKS_JSON = path.resolve(__dirname, '..', '..', '..', 'plugins', 'zn-gate', 'hooks', 'hooks.json');
const posix = process.platform !== 'win32';
const BLOCKING = ['PreToolUse', 'UserPromptSubmit', 'UserPromptExpansion'];

function install(t) {
  const home = tempDir(t, 'zn-b1173-');
  const env = { HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), ZN_HOME: path.join(home, '.zn') };
  claude.install({ env, home, nodePath: process.execPath, runnerPath: RUNNER, mcp: false });
  const data = JSON.parse(fs.readFileSync(claude.settingsFile({ env, home }), 'utf8'));
  return { home, env, data, file: launcher.launcherFile('claude-code', { env, home }) };
}

/** A PATH with sh (the guard runs `sh -c`) and the given extra tools, but no node unless asked. */
function binWith(t, tools) {
  const bin = tempDir(t, 'zn-b1173-bin-');
  fs.symlinkSync('/bin/sh', path.join(bin, 'sh'));
  fs.symlinkSync('/bin/cat', path.join(bin, 'cat'));
  for (const [name, body] of Object.entries(tools || {})) fs.writeFileSync(path.join(bin, name), '#!/bin/sh\n' + body + '\n', { mode: 0o755 });
  return bin;
}

function run(command, pathValue, input) {
  return spawnSync('/bin/sh', ['-c', command], { input: input || '{}', encoding: 'utf8', env: { PATH: pathValue, HOME: '/nonexistent' } });
}

test('start guard: only the blocking events are wrapped, the others keep the plain command', { skip: !posix }, (t) => {
  const { data, file } = install(t);
  for (const ev of BLOCKING) {
    const c = data.hooks[ev][0].hooks[0].command;
    assert.equal(c, launcher.START_GUARD + "'" + file + "' " + ev);
    assert.ok(cfg.isOurs(c, 'claude-code'), ev + ' is still recognized as zn');
  }
  assert.equal(data.hooks.PostToolUse[0].hooks[0].command, "'" + file + "' PostToolUse");
});

test('start guard: launcher file deleted -> exit 2 with the reason', { skip: !posix }, (t) => {
  const { data, file } = install(t);
  fs.unlinkSync(file);
  for (const ev of BLOCKING) {
    const r = run(data.hooks[ev][0].hooks[0].command, binWith(t));
    assert.equal(r.status, 2, ev);
    assert.match(r.stderr, /zn-gate could not start: launcher or node not found; run zn-gate check/);
    assert.doesNotMatch(r.stderr, /missing|No such file/);
  }
  // PostToolUse is not wrapped: the tool already ran, so it stays a plain (non-blocking) 127.
  assert.equal(run(data.hooks.PostToolUse[0].hooks[0].command, binWith(t)).status, 127);
});

test('start guard: launcher not executable -> exit 2 (126)', { skip: !posix }, (t) => {
  const { data, file } = install(t);
  fs.chmodSync(file, 0o644);
  const r = run(data.hooks.PreToolUse[0].hooks[0].command, binWith(t));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /zn-gate could not start: launcher cannot be run; run zn-gate check/);
});

test('start guard: a path with spaces works', { skip: !posix }, (t) => {
  const home = path.join(tempDir(t, 'zn-b1173-sp-'), 'my home dir');
  const env = { HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), ZN_HOME: path.join(home, '.zn') };
  fs.mkdirSync(home, { recursive: true });
  claude.install({ env, home, nodePath: process.execPath, runnerPath: RUNNER, mcp: false });
  const data = JSON.parse(fs.readFileSync(claude.settingsFile({ env, home }), 'utf8'));
  const dir = tempDir(t, 'zn-b1173-proj-');
  fs.writeFileSync(path.join(dir, '.env'), 'API_KEY=sk-test-EXAMPLE0000000000000000\n');
  const ev = { hook_event_name: 'PreToolUse', session_id: 's', cwd: dir, tool_name: 'Bash', tool_input: { command: 'cat .env' } };
  const r = run(data.hooks.PreToolUse[0].hooks[0].command, process.env.PATH, JSON.stringify(ev));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /"permissionDecision":\s*"deny"/, 'stdin reached the real hook through the guard');
  fs.unlinkSync(launcher.launcherFile('claude-code', { env, home }));
  assert.equal(run(data.hooks.PreToolUse[0].hooks[0].command, binWith(t)).status, 2);
});

test('start guard: the exit codes of the command itself pass through, and so does stdin', { skip: !posix }, (t) => {
  for (const code of [0, 1, 2, 3, 130]) {
    const bin = binWith(t, { cmd: 'cat >/dev/null; echo OUT; echo ERR >&2; exit ' + code });
    const r = run(launcher.START_GUARD + 'cmd PreToolUse', bin);
    assert.equal(r.status, code);
    assert.equal(r.stdout, 'OUT\n');
    assert.equal(r.stderr, 'ERR\n');
  }
  const bin = binWith(t, { cmd: 'cat' });
  assert.equal(run(launcher.START_GUARD + 'cmd', bin, 'hello stdin').stdout, 'hello stdin');
});

test('plugin hooks.json: the three blocking hooks carry the guard; node missing -> exit 2; normal codes pass through', { skip: !posix }, (t) => {
  const hooks = JSON.parse(fs.readFileSync(HOOKS_JSON, 'utf8')).hooks;
  const root = path.join(tempDir(t, 'zn-b1173-plugin-'), 'plug in');
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  const sub = (c) => c.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, root);
  for (const ev of BLOCKING) {
    const c = hooks[ev][0].hooks[0].command;
    assert.ok(c.startsWith(launcher.START_GUARD + 'node "${CLAUDE_PLUGIN_ROOT}/scripts/zn-launch.js" hook claude-code'), ev);
    assert.equal(hooks[ev][0].hooks[0].onFailure, 'block');
    const r = run(sub(c), binWith(t));
    assert.equal(r.status, 2, ev + ' without node');
    assert.match(r.stderr, /zn-gate could not start: launcher or node not found; run zn-gate check/);
  }
  // PostToolUse and SessionStart stay plain.
  assert.ok(hooks.PostToolUse[0].hooks[0].command.startsWith('node '));
  assert.ok(hooks.SessionStart[0].hooks[0].command.startsWith('node '));
  // With a node that answers 0, 2 and 1, the hook command passes them through (the path has a space in it).
  for (const code of [0, 2, 1]) {
    const bin = binWith(t, { node: 'echo "$1" >&2; exit ' + code });
    const r = run(sub(hooks.PreToolUse[0].hooks[0].command), bin);
    assert.equal(r.status, code);
    assert.equal(r.stderr.trim(), path.join(root, 'scripts', 'zn-launch.js'));
  }
});

test('start guard: the other adapters with exit-2 blocking get it, Antigravity (deny JSON) and other events do not', () => {
  const f = '/home/u/.zn/hooks/zn-hook-x.sh';
  const g = (agent, ev, plat) => launcher.launcherCommand(f, ev, plat, { agentId: agent });
  assert.ok(g('claude-code', 'PreToolUse').startsWith(launcher.START_GUARD));
  assert.ok(g('codex', 'PreToolUse').startsWith(launcher.START_GUARD));
  assert.ok(g('codex', 'UserPromptSubmit').startsWith(launcher.START_GUARD));
  assert.ok(g('cursor', 'beforeShellExecution').startsWith(launcher.START_GUARD));
  assert.ok(g('gemini', 'BeforeTool').startsWith(launcher.START_GUARD));
  assert.equal(g('codex', 'PermissionRequest'), "'" + f + "' PermissionRequest", 'a deny JSON answers there, not exit 2');
  assert.equal(g('claude-code', 'PostToolUse'), "'" + f + "' PostToolUse");
  assert.equal(g('cursor', 'postToolUse'), "'" + f + "' postToolUse");
  assert.equal(g('antigravity', 'PreToolUse'), "'" + f + "' PreToolUse");
  assert.equal(launcher.launcherCommand(f, 'PreToolUse', 'linux', { plain: true, agentId: 'antigravity' }), f + ' PreToolUse');
  assert.equal(launcher.launcherCommand(f, 'PreToolUse'), "'" + f + "' PreToolUse", 'no agentId: unchanged');
});

test('start guard, windows emulation: Git Bash runs the same text, and check still reads the launcher out of it', () => {
  const cmd = launcher.launcherCommand('C:\\Users\\a b\\.zn\\hooks\\zn-hook-claude-code.sh', 'PreToolUse', 'win32', { agentId: 'claude-code' });
  assert.equal(cmd, launcher.START_GUARD + "'C:/Users/a b/.zn/hooks/zn-hook-claude-code.sh' PreToolUse");
  assert.ok(cfg.isOurs(cmd, 'claude-code'));
  assert.equal(launcher.unguarded(cmd), "'C:/Users/a b/.zn/hooks/zn-hook-claude-code.sh' PreToolUse");
  // The PowerShell scripts (Codex, Cursor, Gemini on Windows) already block on a missing node and on any code except 0 and 2.
  const ps = launcher.windowsScript('cursor', 'preToolUse', 'C:\\n\\node.exe', 'C:\\r\\runner.js');
  assert.match(ps, /Get-Command node/);
  assert.match(ps, /\$LASTEXITCODE -eq 0 -or \$LASTEXITCODE -eq 2/);
  assert.match(ps, /exit 0 # zn hook cursor$/);
});
