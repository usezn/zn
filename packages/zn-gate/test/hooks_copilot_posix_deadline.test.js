'use strict';

// Copilot on macOS and Linux, and Copilot project installs on every system: the hook gets a deadline armed BEFORE Node.js starts
// (2 s before Copilot's own 15 s, which lets the call run: "Timeouts are fail-open for every event, including preToolUse").
//  - user install (macOS, Linux): zn's sh launcher (launcher.unixScript, with the SHA-256 check of the runner);
//  - project install (any system): the same deadline inline in the shared command, because the file cannot name this machine's launcher.
// On expiry the process tree is killed and the answer is Copilot's deny for preToolUse (exit 0) and only a warning for postToolUse.
// The generated text is checked everywhere; the scripts themselves are run for real where sh exists (not on Windows). Values are fake.

process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { getAdapter } = require('../lib/agents');
const cfg = require('../lib/agents/config-file');
const launcher = require('../lib/agents/launcher');
const refresh = require('../lib/agents/refresh');
const { windowsCommandScript } = require('../lib/shell-quote');
const { _internal: { parseCommand } } = require('../lib/check');
const { tempDir } = require('./helpers/tmp');
const { check } = require('../lib/check');

const cop = getAdapter('copilot');
const noSh = process.platform === 'win32' && 'needs sh';

function runnerFile(dir, body) {
  const f = path.join(dir, 'runner.js');
  fs.writeFileSync(f, body);
  return f;
}

function userInstall(t, body = 'process.exit(0);\n') {
  const home = tempDir(t, 'zn-cop-posix-');
  const env = { HOME: home, COPILOT_HOME: path.join(home, '.copilot'), ZN_HOME: path.join(home, '.zn'), PATH: process.env.PATH };
  const runnerDir = path.join(tempDir(t, 'zn-cop-runner-'), 'zn-gate', 'lib', 'hooks');
  fs.mkdirSync(runnerDir, { recursive: true });
  const runner = runnerFile(runnerDir, body);
  const rep = cop.install({ scope: 'user', home, env, platform: 'linux', nodePath: process.execPath, runnerPath: runner });
  const file = cop.hooksFile({ home, env });
  return { home, env, runner, rep, file, data: JSON.parse(fs.readFileSync(file, 'utf8')) };
}

const launcherOf = (env) => launcher.launcherFile('copilot', { env });

// A runner that never answers and leaves a child of its own running: the pids go to files so that the test can see the tree gone.
function hangRunner(dir) {
  const pids = path.join(dir, 'pids');
  return {
    pids,
    body: "const fs = require('fs'), cp = require('child_process');\n" +
      "const c = cp.spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' });\n" +
      'fs.writeFileSync(' + JSON.stringify(pids) + ", process.pid + ' ' + c.pid);\n" +
      'setTimeout(() => {}, 120000);\n',
  };
}

function alive(pid) {
  try {
    const stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z';
  } catch (_) {
    try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
  }
}

function treeGone(pidFile) {
  const ids = fs.readFileSync(pidFile, 'utf8').trim().split(' ').map(Number);
  assert.equal(ids.length, 2);
  // The kill is delivered before the script answers; one beat for the system to finish it.
  const end = Date.now() + 3000;
  while (ids.some(alive) && Date.now() < end) spawnSync('sleep', ['0.1']);
  for (const id of ids) assert.equal(alive(id), false, 'process ' + id + ' is still running');
}

const denyOf = (stdout) => JSON.parse(stdout.trim().split('\n')[0]);

/* ------------------------------ user install, macOS and Linux ------------------------------ */

test('copilot user install on macOS/Linux: both events run through the sh launcher, with the 13 s deadline', (t) => {
  const { env, data, runner } = userInstall(t);
  const file = launcherOf(env);
  for (const ev of ['preToolUse', 'postToolUse']) {
    const h = data.hooks[ev][0];
    assert.equal(h.timeoutSec, 15);
    assert.equal(h.bash, launcher.launcherCommand(file, ev, 'linux'));
    assert.equal(h.powershell, undefined, 'no powershell command on a posix user install');
    assert.ok(cfg.isOurs(h.bash, 'copilot'), ev);
  }
  const text = fs.readFileSync(file, 'utf8');
  assert.equal(fs.statSync(file).mode & 0o777, 0o755);
  assert.ok(text.startsWith('#!/bin/sh\n# Written by `zn hooks install copilot`'));
  assert.ok(text.includes('/bin/sleep 13 & ZN_SP=$!'), 'deadline = 15 - 2');
  assert.equal(launcher.launcherDeadlineS(cop.HOOK_TIMEOUT_S), 13);
  // The SHA-256 check of the runner is the same as for the other agents.
  assert.ok(text.includes('--input-type=commonjs -e "$ZN_VERIFY" "$ZN_RUNNER" "$ZN_SHA" "$ZN_FILES" copilot'));
  assert.ok(text.includes("ZN_SHA='" + launcher.runnerSha(runner) + "'"));
  // The whole file is what unixScript writes for these options.
  assert.equal(text, launcher.unixScript('copilot', process.execPath, runner, { deadlineS: 13, deadlineSoft: true }));
});

test('copilot launcher text: only preToolUse denies (JSON, exit 0); every other event warns on stderr and exits 0', () => {
  const s2 = launcher.unixScript('copilot', '/usr/bin/node', '/opt/zn/runner.js', { deadlineS: 13, deadlineSoft: true, runnerDigest: '', manifest: '' });
  const block = s2.slice(s2.indexOf('zn_block() {'), s2.indexOf('zn_term() {'));
  assert.ok(block.includes('case "$ZN_EVENT" in\n  preToolUse)\n'));
  assert.ok(block.includes('{"permissionDecision":"deny","permissionDecisionReason":"zn: its hook failed'));
  // Copilot never gets an "allow", and the Claude Code spelling of the event blocks nothing here.
  assert.doesNotMatch(s2, /permissionDecision":"allow/);
  assert.ok(!block.includes('\n  PreToolUse|'));
  // The deny is exit 0 (never exit 2: the JSON carries the reason), and the other events print the warning on stderr.
  assert.ok(!block.includes('exit 2'));
  const star = block.slice(block.indexOf('\n  *)\n'));
  assert.ok(star.includes('zn is NOT protecting this session: its hook failed.'));
  assert.ok(star.includes('>&2'));
  assert.doesNotMatch(star, /systemMessage|permissionDecision/);
  assert.ok(star.includes('exit 0 ;;\nesac'));
});

test('copilot launcher, run for real: a runner that never answers is killed at the deadline, tree included, and preToolUse is denied', { skip: noSh }, (t) => {
  const dir = tempDir(t, 'zn-cop-hang-');
  const h = hangRunner(dir);
  const runner = runnerFile(dir, h.body);
  const file = path.join(dir, 'zn-hook-copilot.sh');
  // The deadline is 2 s here (13 s in a real install).
  fs.writeFileSync(file, launcher.unixScript('copilot', process.execPath, runner, { deadlineS: 2, deadlineSoft: true }), { mode: 0o755 });
  const t0 = Date.now();
  const r = spawnSync(file, ['preToolUse'], { input: '{"toolName":"view","toolArgs":{}}', encoding: 'utf8', timeout: 30000, env: { PATH: process.env.PATH, TMPDIR: dir } });
  const took = Date.now() - t0;
  assert.equal(r.status, 0, r.stderr);
  assert.ok(took >= 1500 && took < 12000, 'answered at the deadline, took ' + took);
  const out = denyOf(r.stdout);
  assert.equal(out.permissionDecision, 'deny');
  assert.match(out.permissionDecisionReason, /^zn: its hook failed, so this was blocked/);
  treeGone(h.pids);
  // Nothing is left behind in the temporary folder.
  assert.deepEqual(fs.readdirSync(dir).filter((n) => /^zn-(out|err|ack)\./.test(n)), []);
});

test('copilot launcher, run for real: postToolUse that hangs only warns (stderr, exit 0, nothing on stdout)', { skip: noSh }, (t) => {
  const dir = tempDir(t, 'zn-cop-hang-post-');
  const h = hangRunner(dir);
  const runner = runnerFile(dir, h.body);
  const file = path.join(dir, 'zn-hook-copilot.sh');
  fs.writeFileSync(file, launcher.unixScript('copilot', process.execPath, runner, { deadlineS: 2, deadlineSoft: true }), { mode: 0o755 });
  const r = spawnSync(file, ['postToolUse'], { input: '{}', encoding: 'utf8', timeout: 30000, env: { PATH: process.env.PATH, TMPDIR: dir } });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /zn is NOT protecting this session: its hook failed/);
  treeGone(h.pids);
});

test('copilot launcher, run for real: a runner that answers in time passes its answer on, and a changed runner is not run', { skip: noSh }, (t) => {
  const dir = tempDir(t, 'zn-cop-ok-');
  const runner = runnerFile(dir, "require('fs').writeFileSync(process.env.ZN_HOOK_ACK, 'ok'); process.stdout.write(JSON.stringify({ permissionDecision: 'deny', permissionDecisionReason: 'fake rule' }) + '\\n');\n");
  const file = path.join(dir, 'zn-hook-copilot.sh');
  fs.writeFileSync(file, launcher.unixScript('copilot', process.execPath, runner, { deadlineS: 5, deadlineSoft: true }), { mode: 0o755 });
  const env = { PATH: process.env.PATH, TMPDIR: dir };
  const ok = spawnSync(file, ['preToolUse'], { input: '{}', encoding: 'utf8', timeout: 30000, env });
  assert.equal(ok.status, 0);
  assert.equal(denyOf(ok.stdout).permissionDecisionReason, 'fake rule');
  // The runner is edited after the install: its SHA-256 no longer matches, nothing of it runs, preToolUse is denied.
  fs.appendFileSync(runner, '// edited\n');
  const bad = spawnSync(file, ['preToolUse'], { input: '{}', encoding: 'utf8', timeout: 30000, env });
  assert.equal(bad.status, 0);
  assert.match(denyOf(bad.stdout).permissionDecisionReason, /changed|updated|edited|replaced/i);
  assert.notEqual(denyOf(bad.stdout).permissionDecisionReason, 'fake rule');
});

test('copilot user install: zn-gate check reads the launcher command (node and runner found, SHA recorded)', (t) => {
  const { data, runner } = userInstall(t);
  const pc = parseCommand(data.hooks.preToolUse[0].bash, 'copilot');
  assert.ok(pc && pc.launcher && !pc.unreadable, 'recognised as the launcher');
  assert.equal(pc.event, 'preToolUse');
  assert.equal(pc.node, process.execPath);
  assert.equal(pc.runner, runner);
  assert.equal(pc.sha, launcher.runnerSha(runner));
});

test('copilot user install: reinstall replaces the older plain command with the launcher (no duplicate), uninstall removes it', (t) => {
  const { home, env, data, file, runner } = userInstall(t);
  // What an older zn-gate wrote: the plain node + runner command.
  const old = cfg.hookCommand('copilot', { platform: 'linux', nodePath: process.execPath, runnerPath: runner });
  for (const ev of ['preToolUse', 'postToolUse']) data.hooks[ev][0].bash = old;
  fs.writeFileSync(file, JSON.stringify(data));
  fs.rmSync(launcherOf(env), { force: true });
  assert.ok(cfg.isOurs(old, 'copilot'));
  cop.install({ scope: 'user', home, env, platform: 'linux', nodePath: process.execPath, runnerPath: runner });
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const ev of ['preToolUse', 'postToolUse']) {
    assert.equal(after.hooks[ev].length, 1, ev);
    assert.equal(after.hooks[ev][0].bash, launcher.launcherCommand(launcherOf(env), ev, 'linux'), ev);
  }
  assert.ok(fs.existsSync(launcherOf(env)));
  // A plain uninstall leaves the shared launcher; the machine-wide one removes it.
  cop.uninstall({ scope: 'user', home, env });
  assert.equal(fs.existsSync(file), false);
  assert.ok(fs.existsSync(launcherOf(env)));
  cop.install({ scope: 'user', home, env, platform: 'linux', nodePath: process.execPath, runnerPath: runner });
  cop.uninstall({ scope: 'user', home, env, removeLauncher: true });
  assert.equal(fs.existsSync(launcherOf(env)), false);
});

test('copilot launcher is listed for the machine-wide uninstall and refreshed after an update, keeping its 13 s deadline', (t) => {
  assert.ok(launcher.LAUNCHER_AGENTS.includes('copilot'));
  const { home, env, runner } = userInstall(t);
  const file = launcherOf(env);
  assert.ok(launcher.isOurLauncher(file));
  // The package is updated in place: the runner changes, so the recorded SHA-256 is stale until the postinstall refresh rewrites it.
  fs.appendFileSync(runner, '// new version\n');
  const done = refresh.refreshLaunchers({ env, home, runnerPath: runner, nodePath: process.execPath, platform: 'linux' });
  assert.deepEqual(done, ['copilot']);
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.includes('/bin/sleep 13 & ZN_SP=$!'));
  assert.ok(text.includes("ZN_SHA='" + launcher.runnerSha(runner) + "'"));
  assert.equal(text, launcher.unixScript('copilot', process.execPath, runner, { deadlineS: 13, deadlineSoft: true }));
});

test('copilot: a command of the caller\'s own and Windows keep their old shape (no launcher file)', (t) => {
  const home = tempDir(t, 'zn-cop-own-');
  const env = { HOME: home, COPILOT_HOME: path.join(home, '.copilot'), ZN_HOME: path.join(home, '.zn'), PATH: process.env.PATH };
  cop.install({ scope: 'user', home, env, platform: 'linux', command: 'echo hi' });
  assert.equal(fs.existsSync(launcherOf(env)), false);
  cop.install({ scope: 'user', home, env, platform: 'win32', nodePath: 'C:/n/node.exe', runnerPath: 'C:/zn/runner.js' });
  assert.equal(fs.existsSync(launcherOf(env)), false);
});

/* ------------------------------ project install, every system ------------------------------ */

test('copilot project install: the inline guard carries the 13 s deadline for macOS/Linux and the zr deadline for Windows', (t) => {
  const dir = tempDir(t, 'zn-cop-proj-');
  cop.install({ scope: 'project', projectDir: dir });
  const data = JSON.parse(fs.readFileSync(path.join(dir, '.github', 'hooks', 'zn-gate.json'), 'utf8'));
  assert.equal(launcher.PROJECT_DEADLINE_S.copilot, launcher.launcherDeadlineS(cop.HOOK_TIMEOUT_S));
  for (const ev of ['preToolUse', 'postToolUse']) {
    const h = data.hooks[ev][0];
    assert.equal(h.bash, launcher.projectShCommand('copilot', ev));
    assert.ok(h.bash.includes('/bin/sleep 13 & K=$!'), ev);
    assert.ok(h.bash.includes('"$Z" hook copilot <&3 3<&- >"$O"'), ev);
    // The shared file names no path of this machine: zn and node come from the PATH, as before.
    assert.doesNotMatch(h.bash, /zn-hook-copilot|\.zn\/hooks|ZN_RUNNER/);
    assert.ok(cfg.isOurs(h.bash, 'copilot'));
    assert.ok(launcher.isProjectGuardExact(h.bash, 'copilot'));
    const win = windowsCommandScript(h.powershell);
    assert.equal(win, launcher.projectWindowsScript('copilot', ev));
    assert.match(win, /function zr\(\$f, \$a\)/);
    assert.ok(win.includes('.Wait(13000)'));
    assert.ok(win.includes("$rc = zr (zf 'zn.cmd') 'hook copilot'; if ($rc -eq 0 -or $rc -eq 2) { exit 0 }"));
    assert.ok(launcher.isProjectWindowsScriptExact(win, 'copilot'));
  }
  // preToolUse denies with the JSON, postToolUse only warns.
  assert.ok(data.hooks.preToolUse[0].bash.includes(`echo '"'"'{"permissionDecision":"deny"`));
  assert.doesNotMatch(data.hooks.postToolUse[0].bash, /permissionDecision/);
  // The other agents' project guards are unchanged.
  for (const id of ['claude-code', 'codex', 'cursor', 'gemini']) assert.doesNotMatch(launcher.projectShCommand(id, 'PreToolUse'), /sleep|<&3/, id);
  assert.doesNotMatch(launcher.projectWindowsScript('codex', 'PreToolUse'), /function zr/);
});

test('copilot project install: zn-gate check reads the new guard as exactly zn\'s, and the older one as a guard with no deadline', () => {
  const now = launcher.projectShCommand('copilot', 'preToolUse');
  assert.deepEqual(parseCommand(now, 'copilot'), { onPath: true, guarded: true });
  const old = launcher.projectShCommand('copilot', 'preToolUse', { deadlineS: 0 });
  assert.doesNotMatch(old, /sleep/);
  assert.ok(cfg.isOurs(old, 'copilot'));
  assert.deepEqual(parseCommand(old, 'copilot'), { onPath: true, guarded: true, noDeadline: true });
  // An edited guard is still "modified", whatever the deadline.
  assert.equal(parseCommand(now.replace('/bin/sleep 13', '/bin/sleep 99'), 'copilot').modified, true);
  // Windows.
  const w = launcher.projectWindowsScript('copilot', 'preToolUse');
  assert.deepEqual(parseCommand(launcher.windowsScriptCommand(w), 'copilot'), { onPath: true, guarded: true });
  const wOld = launcher.projectWindowsScript('copilot', 'preToolUse', { deadlineS: 0 });
  assert.deepEqual(parseCommand(launcher.windowsScriptCommand(wOld), 'copilot'), { onPath: true, guarded: true, noDeadline: true });
});

test('copilot project install: reinstall replaces the older guard and the bare command; uninstall removes it', (t) => {
  const dir = tempDir(t, 'zn-cop-proj-mig-');
  const file = cop.hooksFile({ scope: 'project', projectDir: dir });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const mk = (cmd) => ({ type: 'command', bash: cmd, powershell: cmd, timeoutSec: 15 });
  const oldGuard = (ev) => mk(launcher.projectShCommand('copilot', ev, { deadlineS: 0 }));
  fs.writeFileSync(file, JSON.stringify({ version: 1, hooks: { preToolUse: [oldGuard('preToolUse')], postToolUse: [mk('zn hook copilot')] } }));
  cop.install({ scope: 'project', projectDir: dir });
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const ev of ['preToolUse', 'postToolUse']) {
    assert.equal(after.hooks[ev].length, 1, ev);
    assert.equal(after.hooks[ev][0].bash, launcher.projectShCommand('copilot', ev), ev);
  }
  cop.uninstall({ scope: 'project', projectDir: dir });
  assert.equal(fs.existsSync(file), false);
});

// A stand-in `zn` on a PATH of absolute entries (the guard only trusts those), next to the Node.js running the tests.
function guardRun(t, command, znBody, event, input = '{"toolName":"view"}') {
  const dir = tempDir(t, 'zn-cop-guard-');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  if (znBody !== null) fs.writeFileSync(path.join(bin, 'zn'), '#!/bin/sh\n' + znBody, { mode: 0o755 });
  const nodeBin = path.dirname(process.execPath);
  const env = { PATH: [bin, nodeBin, '/usr/bin', '/bin'].join(':'), TMPDIR: dir };
  const t0 = Date.now();
  const r = spawnSync('sh', ['-c', command], { input, encoding: 'utf8', timeout: 30000, env });
  return { r, dir, took: Date.now() - t0, event };
}

function hangZn(pids) {
  // A `zn` that starts a child of its own and then waits for it: neither answers.
  return 'sleep 120 &\nCHILD=$!\necho "$$ $CHILD" > ' + JSON.stringify(pids) + '\nwait\n';
}

test('copilot project guard, run for real: a zn that never answers is killed at the deadline, tree included, and preToolUse is denied', { skip: noSh }, (t) => {
  const pidDir = tempDir(t, 'zn-cop-pids-');
  const pids = path.join(pidDir, 'pids');
  const cmd = launcher.projectShCommand('copilot', 'preToolUse', { deadlineS: 2 });
  const { r, took, dir } = guardRun(t, cmd, hangZn(pids), 'preToolUse');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(took >= 1500 && took < 12000, 'answered at the deadline, took ' + took);
  const out = denyOf(r.stdout);
  assert.equal(out.permissionDecision, 'deny');
  assert.match(out.permissionDecisionReason, /^zn: its hook failed, so this was blocked/);
  treeGone(pids);
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.startsWith('zn-hook')), [], 'the private output file is removed');
});

test('copilot project guard, run for real: postToolUse that hangs only warns (stderr, exit 0, stdout empty)', { skip: noSh }, (t) => {
  const pidDir = tempDir(t, 'zn-cop-pids-');
  const pids = path.join(pidDir, 'pids');
  const cmd = launcher.projectShCommand('copilot', 'postToolUse', { deadlineS: 2 });
  const { r } = guardRun(t, cmd, hangZn(pids), 'postToolUse');
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /zn is NOT protecting this session: its hook failed/);
  treeGone(pids);
});

test('copilot project guard, run for real: an answer in time (status 0 or 2) is passed on; no zn is the "cannot start" deny', { skip: noSh }, (t) => {
  const cmd = launcher.projectShCommand('copilot', 'preToolUse', { deadlineS: 5 });
  const ans = guardRun(t, cmd, 'cat >/dev/null; echo \'{"permissionDecision":"deny","permissionDecisionReason":"fake rule"}\'\n', 'preToolUse');
  assert.equal(ans.r.status, 0);
  assert.equal(denyOf(ans.r.stdout).permissionDecisionReason, 'fake rule');
  const two = guardRun(t, cmd, 'echo refused >&2; exit 2\n', 'preToolUse');
  assert.equal(two.r.status, 2);
  assert.match(two.r.stderr, /refused/);
  const crash = guardRun(t, cmd, 'exit 1\n', 'preToolUse');
  assert.equal(crash.r.status, 0);
  assert.match(denyOf(crash.r.stdout).permissionDecisionReason, /its hook failed/);
  const none = guardRun(t, cmd, null, 'preToolUse');
  assert.equal(none.r.status, 0);
  assert.match(denyOf(none.r.stdout).permissionDecisionReason, /not found on the PATH/);
  // The hook gets the agent's input on stdin through the private file route.
  const echo = guardRun(t, cmd, 'cat\n', 'preToolUse', '{"permissionDecision":"deny","permissionDecisionReason":"from stdin"}');
  assert.equal(denyOf(echo.r.stdout).permissionDecisionReason, 'from stdin');
});

test('copilot project guard, run for real with bash in POSIX mode as sh (as on macOS): same answer', { skip: noSh || !fs.existsSync('/bin/bash') }, (t) => {
  const pidDir = tempDir(t, 'zn-cop-pids-');
  const pids = path.join(pidDir, 'pids');
  const cmd = launcher.projectShCommand('copilot', 'preToolUse', { deadlineS: 2 });
  const dir = tempDir(t, 'zn-cop-bash-');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'zn'), '#!/bin/sh\n' + hangZn(pids), { mode: 0o755 });
  const env = { PATH: [bin, path.dirname(process.execPath), '/usr/bin', '/bin'].join(':'), TMPDIR: dir };
  // The `sh` of the command is a function that runs bash with --posix (no start-up files), which is what bash does when it is called sh.
  const r = spawnSync('/bin/bash', ['--noprofile', '--norc', '-c', 'sh() { /bin/bash --posix --noprofile --norc "$@"; }; ' + cmd], { input: '{}', encoding: 'utf8', timeout: 30000, env });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(denyOf(r.stdout).permissionDecision, 'deny');
  treeGone(pids);
});

test('zn-gate check: protected through the launcher, and a note for a project guard written before the deadline', async (t) => {
  const home = tempDir(t, 'zn-cop-check-home-');
  const env = { HOME: home, PATH: process.env.PATH };
  cop.install({ scope: 'user', home, env, platform: process.platform, nodePath: process.execPath, runnerPath: path.join(__dirname, '..', 'lib', 'hooks', 'runner.js'), mcp: false });
  const cwd = tempDir(t, 'zn-cop-check-cwd-');
  const file = cop.hooksFile({ scope: 'project', projectDir: cwd });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const mk = (ev, opts) => ({ type: 'command', bash: launcher.projectShCommand('copilot', ev, opts), timeoutSec: 15 });
  const ctx = { home, env: { ...env, PATH: process.env.PATH }, cwd, hookTimeoutMs: 60000 };
  fs.writeFileSync(file, JSON.stringify({ version: 1, hooks: { preToolUse: [mk('preToolUse', { deadlineS: 0 })], postToolUse: [mk('postToolUse', { deadlineS: 0 })] } }));
  const old = (await check(ctx)).results.find((r) => r.id === 'copilot');
  assert.equal(old.state, 'protected', old.problem);
  assert.ok(old.notes.some((n) => /no deadline before zn starts/.test(n)), JSON.stringify(old.notes));
  fs.writeFileSync(file, JSON.stringify({ version: 1, hooks: { preToolUse: [mk('preToolUse')], postToolUse: [mk('postToolUse')] } }));
  const now = (await check(ctx)).results.find((r) => r.id === 'copilot');
  assert.equal(now.state, 'protected', now.problem);
  assert.ok(!now.notes.some((n) => /no deadline|was modified/.test(n)), JSON.stringify(now.notes));
});
