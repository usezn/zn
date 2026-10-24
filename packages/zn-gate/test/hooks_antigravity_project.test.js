'use strict';
process.env.ZN_STATS = 'off';

// Antigravity project hook (`zn hooks install antigravity --project`): the shared .agents/hooks.json names `zn` on
// the PATH, so it carries its own guard. Antigravity runs the command split on spaces with no shell; these tests run
// it that way with the real sh, with zn or node missing, and check that the deny JSON with the repair text is printed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { getAdapter } = require('../lib/agents');
const launcher = require('../lib/agents/launcher');
const cfg = require('../lib/agents/config-file');
const { windowsCommandScript } = require('../lib/shell-quote');
const { tempDir } = require('./helpers/tmp');

const agy = getAdapter('antigravity');
const RUNNER = path.join(__dirname, '..', 'lib', 'hooks', 'runner.js');
const skip = { skip: process.platform === 'win32' };
const EVENT = JSON.stringify({ conversationId: 'c', workspacePaths: ['/work/proj'], toolCall: { name: 'search_web', args: { query: 'x' } }, stepIdx: 1 });

function projectCommand(t) {
  const dir = tempDir(t, 'zn-agy-proj-');
  agy.install({ scope: 'project', projectDir: dir });
  const data = JSON.parse(fs.readFileSync(path.join(dir, '.agents', 'hooks.json'), 'utf8'));
  return { dir, command: data['zn-gate'].PreToolUse[0].hooks[0].command };
}

function whichSh() {
  for (const d of String(process.env.PATH || '').split(':')) {
    const f = path.join(d, 'sh');
    if (d && fs.existsSync(f)) return fs.realpathSync(f);
  }
  return '/bin/sh';
}

/* A folder that is the whole PATH: sh, and optionally a fake zn and a node. */
function mkbin(t, { zn, node, shell } = {}) {
  const bin = tempDir(t, 'zn-agy-bin-');
  fs.symlinkSync(shell || whichSh(), path.join(bin, 'sh'));
  if (zn !== undefined && zn !== null) { fs.writeFileSync(path.join(bin, 'zn'), '#!' + (shell || whichSh()) + '\n' + zn + '\n'); fs.chmodSync(path.join(bin, 'zn'), 0o755); }
  if (node) fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  return bin;
}

// As Antigravity runs it: split on spaces, no shell.
function naive(command, bin, input = EVENT) {
  const parts = command.split(' ');
  return spawnSync(parts[0], parts.slice(1), { input, encoding: 'utf8', env: { PATH: bin }, cwd: '/' });
}

const ALLOW = "echo '{\"decision\":\"allow\"}'";

test('the project command is one sh -c with a script that holds no space, quote-break or shell metacharacter of the split', skip, (t) => {
  const { command } = projectCommand(t);
  const parts = command.split(' ');
  assert.equal(parts.length, 3);
  assert.deepEqual(parts.slice(0, 2), ['sh', '-c']);
  assert.ok(!/\s/.test(parts[2]));
  assert.ok(launcher.isProjectGuard(command, 'antigravity'));
  assert.ok(cfg.isOurs(command, 'antigravity'));
  assert.equal(cfg.isOurs('sh -c :;echo${IFS}hi', 'antigravity'), false);
});

test('zn and node found: the hook runs `zn hook antigravity`, stdin goes through, an answer and a refusal pass unchanged', skip, (t) => {
  const { command } = projectCommand(t);
  const echoed = naive(command, mkbin(t, { node: true, zn: 'cat >/dev/null; echo "{\\"decision\\":\\"allow\\",\\"reason\\":\\"$1 $2\\"}"' }));
  assert.equal(echoed.status, 0, echoed.stderr);
  assert.deepEqual(JSON.parse(echoed.stdout), { decision: 'allow', reason: 'hook antigravity' });
  const seen = naive(command, mkbin(t, { node: true, zn: 'cat > ' + JSON.stringify(path.join(tempDir(t, 'zn-agy-in-'), 'in.json')) + '; ' + ALLOW }));
  assert.equal(seen.status, 0);
  const refused = naive(command, mkbin(t, { node: true, zn: 'echo \'{"decision":"deny","reason":"own refusal"}\'; exit 2' }));
  assert.equal(refused.status, 2);
  assert.equal(JSON.parse(refused.stdout).reason, 'own refusal');
});

test('zn missing: prints the deny JSON with the repair step, exit 0 (no exit 127, no silence)', skip, (t) => {
  const { command } = projectCommand(t);
  const r = naive(command, mkbin(t, { node: true }));
  assert.equal(r.status, 0, r.stderr);
  const o = JSON.parse(r.stdout);
  assert.equal(o.decision, 'deny');
  assert.match(o.reason, /zn or Node\.js was not found/);
  assert.match(o.reason, /npm install -g zn-gate/);
});

test('node missing, or both missing: the same deny JSON', skip, (t) => {
  const { command } = projectCommand(t);
  for (const bin of [mkbin(t, { zn: ALLOW }), mkbin(t, {})]) {
    const r = naive(command, bin);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).decision, 'deny');
    assert.match(JSON.parse(r.stdout).reason, /npm install -g zn-gate/);
  }
});

test('zn starts and then fails (exit 1, 127, a crash): a deny that points to zn-gate check', skip, (t) => {
  const { command } = projectCommand(t);
  for (const body of ['exit 1', 'exit 127', 'kill -9 $$']) {
    const r = naive(command, mkbin(t, { node: true, zn: body }));
    const out = JSON.parse(r.stdout);
    assert.equal(out.decision, 'deny', body);
    assert.match(out.reason, /zn-gate check/);
    assert.equal(r.status, 0);
  }
});

test('a zn that is only on a relative PATH entry is not run', skip, (t) => {
  const { command } = projectCommand(t);
  const bin = mkbin(t, { node: true });
  const work = tempDir(t, 'zn-agy-rel-');
  fs.writeFileSync(path.join(work, 'zn'), '#!/bin/sh\necho \'{"decision":"allow","reason":"planted"}\'\n');
  fs.chmodSync(path.join(work, 'zn'), 0o755);
  const r = spawnSync(command.split(' ')[0], command.split(' ').slice(1), { input: EVENT, encoding: 'utf8', env: { PATH: '.:' + bin }, cwd: work });
  const o = JSON.parse(r.stdout);
  assert.equal(o.decision, 'deny');
  assert.ok(!/planted/.test(r.stdout));
});

test('it works the same with dash, bash and when a shell runs the whole line', skip, (t) => {
  const { command } = projectCommand(t);
  const shells = ['dash', 'bash'].map((n) => ['/bin', '/usr/bin'].map((d) => path.join(d, n)).find((f) => fs.existsSync(f))).filter(Boolean);
  assert.ok(shells.length >= 1);
  for (const shell of shells) {
    const missing = naive(command, mkbin(t, { node: true, shell }));
    assert.equal(JSON.parse(missing.stdout).decision, 'deny', shell);
    const ok = naive(command, mkbin(t, { node: true, shell, zn: ALLOW }));
    assert.equal(JSON.parse(ok.stdout).decision, 'allow', shell);
    // If Antigravity did hand the line to a shell, the script still gives the same answers.
    const bin = mkbin(t, { node: true, shell });
    const viaShell = spawnSync(shell, ['-c', command], { input: EVENT, encoding: 'utf8', env: { PATH: bin } });
    assert.equal(JSON.parse(viaShell.stdout).decision, 'deny', shell + ' outer shell');
    const bin2 = mkbin(t, { node: true, shell, zn: ALLOW });
    const viaShell2 = spawnSync(shell, ['-c', command], { input: EVENT, encoding: 'utf8', env: { PATH: bin2 } });
    assert.equal(JSON.parse(viaShell2.stdout).decision, 'allow', shell + ' outer shell');
  }
});

test('with the real zn hook behind it, the project command answers the real decision', skip, (t) => {
  const { command } = projectCommand(t);
  const bin = mkbin(t, { node: true, zn: 'exec "' + process.execPath + '" "' + RUNNER + '" "$2"' });
  const cred = path.join(tempDir(t, 'zn-agy-home-'), '.ssh', 'id_rsa');
  const read = JSON.stringify({ conversationId: 'c', workspacePaths: ['/work/proj'], toolCall: { name: 'view_file', args: { AbsolutePath: cred } }, stepIdx: 1 });
  const home = path.dirname(path.dirname(cred));
  const r = spawnSync(command.split(' ')[0], command.split(' ').slice(1), { input: read, encoding: 'utf8', env: { PATH: bin, HOME: home, USERPROFILE: home, ZN_STATS: 'off' } });
  assert.equal(JSON.parse(r.stdout).decision, 'deny', r.stdout + r.stderr);
  const ok = naive(command, bin);
  assert.equal(JSON.parse(ok.stdout).decision, 'allow', ok.stdout + ok.stderr);
});

test('install --project: idempotent, uninstall removes it, a hand-written zn-gate entry stays', skip, (t) => {
  const { dir, command } = projectCommand(t);
  agy.install({ scope: 'project', projectDir: dir });
  const file = path.join(dir, '.agents', 'hooks.json');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8'))['zn-gate'].PreToolUse.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8'))['zn-gate'].PreToolUse[0].hooks[0].command, command);
  assert.equal(agy.uninstall({ scope: 'project', projectDir: dir }).removed, 1);
  assert.equal(fs.existsSync(file), false);
  // an older zn-gate wrote the plain command: a new install replaces it
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ 'zn-gate': { enabled: true, PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'zn hook antigravity', timeout: 15 }] }] } }));
  agy.install({ scope: 'project', projectDir: dir });
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(Object.keys(data).length, 1);
  assert.equal(data['zn-gate'].PreToolUse[0].hooks[0].command, command);
});

test('install --project --self-check: zn missing is reported as a failed self-check, zn present passes', skip, (t) => {
  const dir = tempDir(t, 'zn-agy-sc-');
  const bad = agy.install({ scope: 'project', projectDir: dir, selfCheck: true, env: { PATH: mkbin(t, { node: true }) } });
  assert.equal(bad.selfCheck.ok, false);
  assert.match(bad.selfCheck.detail, /deny/);
  assert.ok(bad.warnings.some((w) => /SELF-CHECK FAILED/.test(w)));
  const good = agy.install({ scope: 'project', projectDir: dir, selfCheck: true, env: { PATH: mkbin(t, { node: true, zn: 'exec "' + process.execPath + '" "' + RUNNER + '" "$2"' }) } });
  assert.equal(good.selfCheck.ok, true, JSON.stringify(good.selfCheck));
  assert.ok(good.warnings.some((w) => /Without it the hook answers a deny/.test(w)));
});

test('Windows: the project hook is an encoded PowerShell script with the same steps; isOurs and uninstall find it', (t) => {
  const dir = tempDir(t, 'zn-agy-win-');
  agy.install({ scope: 'project', projectDir: dir, platform: 'win32' });
  const file = path.join(dir, '.agents', 'hooks.json');
  const command = JSON.parse(fs.readFileSync(file, 'utf8'))['zn-gate'].PreToolUse[0].hooks[0].command;
  assert.match(command, /^powershell\.exe -NoProfile -NonInteractive -EncodedCommand [A-Za-z0-9+/=]+$/);
  assert.equal(command.split(' ').length, 5, 'no space inside the argument');
  const script = windowsCommandScript(command);
  assert.ok(launcher.isProjectWindowsScript(script, 'antigravity'));
  assert.match(script, /\(zf 'zn\.cmd'\)/);
  assert.match(script, /\{"decision":"deny","reason":"zn: its hook cannot start because zn or Node\.js was not found/);
  assert.match(script, /# zn hook antigravity$/);
  assert.ok(cfg.isOurs(command, 'antigravity'));
  assert.equal(agy.uninstall({ scope: 'project', projectDir: dir }).removed, 1);
});

test('zn-gate check reads the guarded project command as zn\'s own (sh form and PowerShell form)', (t) => {
  const parseCommandForTest = require('../lib/check')._internal.parseCommand;
  const sh = parseCommandForTest(launcher.projectShCommand('antigravity'), 'antigravity');
  assert.deepEqual(sh, { onPath: true, guarded: true });
  const win = parseCommandForTest(launcher.windowsScriptCommand(launcher.projectWindowsScript('antigravity')), 'antigravity');
  assert.deepEqual(win, { onPath: true, guarded: true });
  assert.equal(parseCommandForTest('sh -c :;echo${IFS}hi', 'antigravity'), null);
});

test('the project guard is recognized by its structure when its wording changes', () => {
  const sh = launcher.projectShCommand('antigravity');
  const reworded = sh.replace('blocked.', 'stopped.');
  assert.notEqual(reworded, sh);
  assert.equal(launcher.isProjectGuard(reworded, 'antigravity'), true);
  assert.equal(launcher.isProjectGuard('sh -c :;echo${IFS}hi', 'antigravity'), false);
  assert.equal(launcher.isProjectGuard(sh, 'cursor'), false);
  const ps = launcher.projectWindowsScript('antigravity');
  assert.equal(launcher.isProjectWindowsScript(ps.replace('exit 0 #', 'exit 0 ; # note #').replace('; # note #', ' #'), 'antigravity'), true);
  assert.equal(launcher.isProjectWindowsScript('Write-Output hi # zn hook antigravity', 'antigravity'), false);
});
