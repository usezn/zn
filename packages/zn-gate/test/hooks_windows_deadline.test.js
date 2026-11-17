'use strict';

// Codex on Windows and Copilot (user installs): the hook is a PowerShell script that runs Node.js as a child with a deadline
// armed BEFORE Node.js starts (2 s before the agent's own timeout, which for both agents lets the call run). A stall before
// zn's own supervisor (a slow disk, an antivirus scan of node.exe, a cold start under load) ends in zn's block, not in
// "Codex/Copilot timed out, run the tool". The generated text is checked on every platform; the script itself runs only where
// PowerShell exists (the Windows CI job). Values are fake.

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
const { _internal: { parseCommand } } = require('../lib/check');
const { tempDir } = require('./helpers/tmp');

const codex = getAdapter('codex');
const cop = getAdapter('copilot');
const N = 'C:/Program Files/nodejs/node.exe';
const R = 'C:/zn/zn-gate/lib/hooks/runner.js';
const winOnly = process.platform !== 'win32' && 'needs PowerShell (the Windows CI job)';

function codexWin(t, platform = 'win32') {
  const home = tempDir(t, 'zn-win-deadline-codex-');
  const env = { HOME: home, CODEX_HOME: path.join(home, '.codex'), ZN_HOME: path.join(home, '.zn'), PATH: process.env.PATH };
  codex.install({ env, home, platform, nodePath: N, runnerPath: R, mcp: false });
  return JSON.parse(fs.readFileSync(codex.hooksFile({ env }), 'utf8'));
}

function copilotWin(t) {
  const home = tempDir(t, 'zn-win-deadline-copilot-');
  const env = { HOME: home, COPILOT_HOME: path.join(home, '.copilot') };
  cop.install({ scope: 'user', home, env, platform: 'win32', nodePath: N, runnerPath: R });
  return { home, env, data: JSON.parse(fs.readFileSync(cop.hooksFile({ home, env }), 'utf8')) };
}

test('codex on Windows: every command gets the deadline, 2 s before the 30 s that lets the call run', (t) => {
  const data = codexWin(t);
  for (const ev of ['PreToolUse', 'PermissionRequest', 'PostToolUse', 'UserPromptSubmit', 'SessionStart', 'SubagentStart', 'Stop']) {
    const h = data.hooks[ev][0].hooks[0];
    assert.equal(h.timeout, 30);
    const script = windowsCommandScript(h.commandWindows);
    assert.match(script, /function zr\(\$f, \$a\)/, ev);
    assert.ok(script.includes('.Wait(28000)'), ev);
    assert.ok(script.includes('taskkill.exe" /PID $p.Id /T /F'), ev);
    assert.match(script, / # zn hook codex$/, ev);
    assert.ok(cfg.isOurs(h.commandWindows, 'codex'), ev);
    // Codex starts this through cmd.exe /C: the command line has a hard limit of 8191 characters.
    assert.ok(h.commandWindows.length < 8000, ev + ' command is ' + h.commandWindows.length + ' characters');
  }
});

test('codex on Windows: a timeout answers with the block of the event (exit 2 / deny JSON), and an event that cannot block only warns', () => {
  const s = (ev) => launcher.windowsScript('codex', ev, N, R, { deadlineS: 28 });
  assert.match(s('PreToolUse'), /Console\]::Error\.WriteLine\('zn: its hook failed.*exit 2 # zn hook codex$/);
  assert.match(s('UserPromptSubmit'), /exit 2 # zn hook codex$/);
  assert.match(s('PermissionRequest'), /permissionDecision|behavior":"deny".*exit 0 # zn hook codex$/);
  assert.match(s('PostToolUse'), /systemMessage.*exit 0 # zn hook codex$/);
  assert.doesNotMatch(s('PostToolUse'), /exit 2 # zn hook/);
  // The timed-out child is the same "crash" path as a hook that failed: only 0 with the ack, or 2, leave early.
  assert.match(s('PreToolUse'), /\$rc = zr .*runner\.js" codex'; if \(\(\$rc -eq 0 -and \(zk\)\) -or \$rc -eq 2\) \{ zx \$rc \}/);
});

test('codex on Windows: the integrity and no-deadline text of other agents is unchanged', () => {
  for (const id of ['cursor', 'gemini', 'antigravity']) {
    assert.doesNotMatch(launcher.windowsScript(id, 'PreToolUse', N, R), /function zr|taskkill|Stopwatch/, id);
  }
  assert.doesNotMatch(launcher.windowsScript('codex', 'PreToolUse', N, R), /function zr/);
});

test('copilot on Windows: the powershell command gets the deadline (13 s of 15 s) and still names zn', (t) => {
  const { data } = copilotWin(t);
  for (const ev of ['preToolUse', 'postToolUse']) {
    const h = data.hooks[ev][0];
    assert.equal(h.timeoutSec, 15);
    assert.match(h.powershell, /^C:\/Windows\/System32\/WindowsPowerShell\/v1\.0\/powershell\.exe -NoProfile -NonInteractive -EncodedCommand /);
    const script = windowsCommandScript(h.powershell);
    assert.match(script, /function zr\(\$f, \$a\)/, ev);
    assert.ok(script.includes('.Wait(13000)'), ev);
    assert.ok(script.includes('taskkill.exe" /PID $p.Id /T /F'), ev);
    assert.match(script, / # zn hook copilot$/, ev);
    assert.ok(cfg.isOurs(h.powershell, 'copilot'), ev);
    // The bash command (macOS, Linux) is not a script: it is the plain command and is left as it was.
    assert.ok(h.bash && h.bash !== h.powershell);
  }
});

test('copilot on Windows: a timeout denies preToolUse with the JSON Copilot reads, and only warns on postToolUse', () => {
  const s = (ev) => launcher.windowsScript('copilot', ev, N, R, { deadlineS: 13 });
  const pre = s('preToolUse');
  // A hook that ran and did not answer in time (zt = 1) is denied with the crash text; a hook that cannot start, with the missing text.
  assert.match(pre, /if \(\$zt -eq 1\) \{ zd; \[Console\]::Out\.WriteLine\('\{"permissionDecision":"deny","permissionDecisionReason":"zn: its hook failed[^']*'\); \[Console\]::Error\.WriteLine\('[^']*'\); exit 0 \}/);
  assert.match(pre, /exit 0 # zn hook copilot$/);
  // Copilot never gets an "allow" and never an exit that lets preToolUse through.
  assert.doesNotMatch(pre, /permissionDecision":"allow/);
  assert.match(pre, /if \(\(\$rc -eq 0 -and \(zk\)\) -or \$rc -eq 2\) \{ zx 0 \}/);
  const post = s('postToolUse');
  assert.doesNotMatch(post, /permissionDecision/);
  assert.match(post, /if \(\$zt -eq 1\) \{ zd; \[Console\]::Error\.WriteLine\('zn is NOT protecting this session: its hook failed[^']*'\); exit 0 \}/);
  assert.match(post, /exit 0 # zn hook copilot$/);
  // The VS Code spelling of the event names does not block anything here: zn installs the camelCase ones.
  assert.doesNotMatch(s('PreToolUse'), /permissionDecision/);
});

test('copilot on Windows: zn-gate check reads the new script as zn\'s own (runner and node found)', (t) => {
  const { data } = copilotWin(t);
  const pc = parseCommand(data.hooks.preToolUse[0].powershell, 'copilot');
  assert.ok(pc && pc.winScript, 'recognised as a zn script');
  assert.equal(pc.node, N);
  assert.equal(pc.runner, R);
});

test('copilot and codex on Windows: reinstall replaces an older command with the deadline script, and uninstall removes it', (t) => {
  const { home, env, data } = copilotWin(t);
  const file = cop.hooksFile({ home, env });
  // An older zn-gate wrote the plain powershell.exe command (no script, no deadline).
  const old = cfg.hookCommandWindows('copilot', { platform: 'win32', nodePath: N, runnerPath: R });
  data.hooks.preToolUse[0].powershell = old;
  fs.writeFileSync(file, JSON.stringify(data));
  assert.ok(cfg.isOurs(old, 'copilot'));
  cop.install({ scope: 'user', home, env, platform: 'win32', nodePath: N, runnerPath: R });
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(after.hooks.preToolUse.length, 1);
  assert.ok(windowsCommandScript(after.hooks.preToolUse[0].powershell).includes('.Wait(13000)'));
  cop.uninstall({ scope: 'user', home, env });
  assert.equal(fs.existsSync(file) ? JSON.stringify(JSON.parse(fs.readFileSync(file, 'utf8')).hooks || {}) : '{}', '{}');
});

test('copilot project install keeps its own start guard (the deadline is for the user install)', (t) => {
  const dir = tempDir(t, 'zn-win-deadline-project-');
  cop.install({ scope: 'project', projectDir: dir, platform: 'win32' });
  const h = JSON.parse(fs.readFileSync(path.join(dir, '.github', 'hooks', 'zn-gate.json'), 'utf8')).hooks.preToolUse[0];
  assert.ok(launcher.isProjectWindowsScript(windowsCommandScript(h.powershell), 'copilot'));
});

// The script itself, in PowerShell: a hook that never answers is killed at the deadline and zn answers by itself.
function runScript(script, input) {
  const cmd = launcher.windowsScriptCommand(script).split(' ');
  return spawnSync(cmd[0], cmd.slice(1), { input, encoding: 'utf8', timeout: 60000, windowsHide: true });
}

function stallingRunner(t) {
  const dir = tempDir(t, 'zn-win-deadline-run-');
  const file = path.join(dir, 'runner.js').replace(/\\/g, '/');
  fs.writeFileSync(file, 'setTimeout(() => {}, 120000);\n');
  return file;
}

test('Windows (PowerShell): codex hook that stalls is killed at the deadline and blocks PreToolUse with exit 2', { skip: winOnly }, (t) => {
  const runner = stallingRunner(t);
  const script = launcher.windowsScript('codex', 'PreToolUse', process.execPath.replace(/\\/g, '/'), runner, { deadlineS: 2 });
  const t0 = Date.now();
  const r = runScript(script, '{}');
  assert.ok(Date.now() - t0 < 20000, 'the deadline fired');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /zn: its hook failed/);
});

test('Windows (PowerShell): copilot hook that stalls denies preToolUse with the JSON and exit 0', { skip: winOnly }, (t) => {
  const runner = stallingRunner(t);
  const script = launcher.windowsScript('copilot', 'preToolUse', process.execPath.replace(/\\/g, '/'), runner, { deadlineS: 2 });
  const t0 = Date.now();
  const r = runScript(script, '{}');
  assert.ok(Date.now() - t0 < 20000, 'the deadline fired');
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout.trim().split(/\r?\n/)[0]).permissionDecision, 'deny');
});
