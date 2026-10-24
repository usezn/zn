'use strict';

// zn hooks install codex: the hook command goes through a launcher that still
// blocks when the Node.js it was installed with is gone (Codex runs a call
// unchecked when a hook cannot start, exit 127, so the launcher must not
// depend on Node.js to block). Values are fake.

process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { getAdapter } = require('../lib/agents');
const cfg = require('../lib/agents/config-file');
const launcher = require('../lib/agents/launcher');
const { windowsCommandScript } = require('../lib/shell-quote');
const { check } = require('../lib/check');
const { tempDir } = require('./helpers/tmp');

const codex = getAdapter('codex');
const RUNNER = path.resolve(__dirname, '..', 'lib', 'hooks', 'runner.js');
const posix = process.platform !== 'win32';
const GONE = '/nonexistent/node-gone/bin/node';
const REINSTALL = 'install zn-gate again for the Node.js you use now: run `npm install -g zn-gate`, then `zn hooks install codex`, in your own terminal';

function setup(t, nodePath) {
  const home = tempDir(t, 'zn-b93-');
  const env = { HOME: home, CODEX_HOME: path.join(home, '.codex'), ZN_HOME: path.join(home, '.zn'), PATH: process.env.PATH };
  codex.install({ env, home, nodePath, runnerPath: RUNNER, mcp: false });
  const data = JSON.parse(fs.readFileSync(codex.hooksFile({ env }), 'utf8'));
  return { home, env, data, file: launcher.launcherFile('codex', { env, home }) };
}

// A PATH with no node and no zn (the launcher only uses shell builtins).
function emptyBin(t) { return tempDir(t, 'zn-b93-bin-'); }

function runLauncher(file, event, input, pathValue) {
  return spawnSync('/bin/sh', [file, event], { input, encoding: 'utf8', env: { PATH: pathValue, HOME: '/nonexistent' } });
}

function breakNode(file) {
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^ZN_NODE=.*$/m, "ZN_NODE='" + GONE + "'"));
}

test('codex install: a user install writes the launcher and one command per event', { skip: !posix }, (t) => {
  const { data, file } = setup(t, process.execPath);
  assert.ok(fs.existsSync(file));
  assert.equal(fs.statSync(file).mode & 0o777, 0o755);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  for (const ev of ['PreToolUse', 'PermissionRequest', 'PostToolUse', 'UserPromptSubmit', 'SessionStart', 'SubagentStart', 'Stop']) {
    const h = data.hooks[ev][0].hooks[0];
    assert.equal(h.command, "'" + file + "' " + ev);
    assert.ok(cfg.isOurs(h.command, 'codex'), ev + ' is recognized as zn\'s');
    assert.match(windowsCommandScript(h.commandWindows), / # zn hook codex$/);
    assert.ok(cfg.isOurs(h.commandWindows, 'codex'));
  }
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.includes("\nZN_NODE='" + process.execPath + "'\n"));
  assert.match(text, /^ZN_RUNNER='.*runner\.js'$/m);
});

test('codex launcher: with the recorded Node.js it runs the real hook and blocks .env', { skip: !posix }, (t) => {
  const { file } = setup(t, process.execPath);
  const dir = tempDir(t, 'zn-b93-proj-');
  fs.writeFileSync(path.join(dir, '.env'), 'API_KEY=sk-test-EXAMPLE0000000000000000\n');
  const ev = { hook_event_name: 'PreToolUse', session_id: 's', cwd: dir, tool_name: 'Bash', tool_input: { command: 'cat .env' } };
  const r = runLauncher(file, 'PreToolUse', JSON.stringify(ev), process.env.PATH);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /"permissionDecision":\s*"deny"/);
});

test('codex launcher: Node.js gone and no zn on PATH: it still blocks, with the exit codes Codex documents', { skip: !posix }, (t) => {
  const { file } = setup(t, GONE);
  const bin = emptyBin(t);
  for (const ev of ['PreToolUse', 'UserPromptSubmit']) {
    const r = runLauncher(file, ev, '{}', bin);
    assert.equal(r.status, 2, ev + ' exits 2 (Codex: exit code 2 with the reason on stderr blocks)');
    assert.match(r.stderr, /zn: its hook cannot start/);
    assert.match(r.stderr, /zn hooks install codex/);
    assert.equal(r.stdout, '');
  }
  const p = runLauncher(file, 'PermissionRequest', '{}', bin);
  assert.equal(p.status, 0);
  const pj = JSON.parse(p.stdout);
  assert.equal(pj.hookSpecificOutput.hookEventName, 'PermissionRequest');
  assert.equal(pj.hookSpecificOutput.decision.behavior, 'deny');
  assert.match(pj.hookSpecificOutput.decision.message, /zn hooks install codex/);
  // Where blocking would hide a tool result or loop the model: a warning the user sees, exit 0.
  for (const ev of ['PostToolUse', 'Stop', 'SessionStart', 'SubagentStart']) {
    const r = runLauncher(file, ev, '{}', bin);
    assert.equal(r.status, 0, ev);
    assert.match(JSON.parse(r.stdout).systemMessage, /NOT protecting this session.*zn hooks install codex/);
  }
});

test('codex launcher: recorded Node.js gone but zn and node on an absolute PATH: runs zn hook', { skip: !posix }, (t) => {
  const { file } = setup(t, GONE);
  const bin = tempDir(t, 'zn-b93-bin-');
  fs.writeFileSync(path.join(bin, 'node'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'zn'), '#!/bin/sh\necho "VIA_ZN $*"\n', { mode: 0o755 });
  const r = runLauncher(file, 'PreToolUse', '{}', bin);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), 'VIA_ZN hook codex');
});

test('codex launcher: a zn found through a relative PATH entry is not run (it blocks)', { skip: !posix }, (t) => {
  const { file } = setup(t, GONE);
  const bin = tempDir(t, 'zn-b93-bin-');
  fs.writeFileSync(path.join(bin, 'node'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'zn'), '#!/bin/sh\necho PLANTED\n', { mode: 0o755 });
  const r = spawnSync('/bin/sh', [file, 'PreToolUse'], { input: '{}', encoding: 'utf8', cwd: bin, env: { PATH: '.', HOME: '/nonexistent' } });
  assert.equal(r.status, 2);
  assert.doesNotMatch(r.stdout, /PLANTED/);
});

test('codex uninstall removes the launcher; a project install writes none', { skip: !posix }, (t) => {
  const { env, home, file } = setup(t, process.execPath);
  assert.ok(fs.existsSync(file));
  codex.uninstall({ env, home, removeLauncher: true });
  assert.equal(fs.existsSync(file), false);
  const proj = tempDir(t, 'zn-b93-proj-');
  codex.install({ scope: 'project', projectDir: proj, env, home, mcp: false });
  const data = JSON.parse(fs.readFileSync(path.join(proj, '.codex', 'hooks.json'), 'utf8'));
  assert.equal(data.hooks.PreToolUse[0].hooks[0].command, 'zn hook codex');
  assert.equal(fs.existsSync(file), false);
});

test('codex windows command: a path that needs escaping keeps the plain command', () => {
  assert.equal(launcher.windowsScript('codex', 'PreToolUse', "C:/it's/node.exe", 'C:/x/runner.js'), null);
  const s = launcher.windowsScript('codex', 'PreToolUse', 'C:/node/node.exe', 'C:/z/zn-gate/lib/hooks/runner.js');
  assert.match(s, /^\$ProgressPreference='SilentlyContinue'; \$zt=0; function zf\(\$x\) \{.*?return \$null \}; if \(\[System\.IO\.File\]::Exists\('C:\/node\/node\.exe'\)/);
  assert.match(s, /exit 2 # zn hook codex$/);
  assert.match(launcher.windowsScript('codex', 'Stop', 'C:/node/node.exe', 'C:/r.js'), /systemMessage.*exit 0 # zn hook codex$/);
});

test('check: the Node.js recorded in the launcher is gone and nothing else can run the hook: not protected', { skip: !posix }, async (t) => {
  const { home, env, file } = setup(t, process.execPath);
  breakNode(file);
  const r = (await check({ home, env: { ...env, PATH: emptyBin(t) }, cwd: tempDir(t, 'zn-b93-cwd-') })).results.find((x) => x.id === 'codex');
  assert.equal(r.state, 'not-protected');
  assert.match(r.problem, /Node\.js \(\/nonexistent\/node-gone\/bin\/node\) is no longer there, so zn now blocks the tool calls/);
  assert.equal(r.fix, REINSTALL);
});

test('check: the recorded Node.js is gone but zn and node are on the PATH: protected, with a note to reinstall', { skip: !posix }, async (t) => {
  const { home, env, file } = setup(t, process.execPath);
  breakNode(file);
  const bin = tempDir(t, 'zn-b93-bin-');
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  // A stand-in `zn` that runs the real hook runner, as `zn hook codex` does.
  fs.writeFileSync(path.join(bin, 'zn'), '#!/bin/sh\nexec "' + process.execPath + '" "' + RUNNER + '" "$2"\n', { mode: 0o755 });
  const r = (await check({ home, env: { ...env, PATH: bin }, cwd: tempDir(t, 'zn-b93-cwd-') })).results.find((x) => x.id === 'codex');
  assert.equal(r.state, 'protected', r.problem);
  assert.ok(r.notes.some((n) => /now runs `zn` from your PATH.*zn hooks install codex/.test(n)));
});

test('check: a launcher script that was deleted is reported', { skip: !posix }, async (t) => {
  const { home, env, file } = setup(t, process.execPath);
  fs.unlinkSync(file);
  const r = (await check({ home, env, cwd: tempDir(t, 'zn-b93-cwd-') })).results.find((x) => x.id === 'codex');
  assert.equal(r.state, 'not-protected');
  assert.match(r.problem, /launcher script .* is missing or was changed/);
});
