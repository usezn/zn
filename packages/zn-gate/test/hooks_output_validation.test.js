'use strict';

// A hook whose answer never reached the agent must not count as done (a status 0 with no answer is a fail-open):
//  - a failed write on the hook's stdout (EPIPE) ends with a non-zero status, never 0;
//  - the launchers accept a status 0 only when the hook confirmed (ZN_HOOK_ACK) that it wrote its whole answer;
//    a runner that stops half way (prints "{", exits 0) is a failure and ends in the launcher's own block.
// Values are fake. Everything runs in a temporary home.

process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const launcher = require('../lib/agents/launcher');
const { tempDir } = require('./helpers/tmp');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'cli.js');
const RUNNER = path.join(ROOT, 'lib', 'hooks', 'runner.js');
const EPIPE_ON_WINDOWS = 'fails on Windows today: the launcher does not block the call when the answer of the runner cannot be written (EPIPE); not fixed yet';
const TERM_ON_WINDOWS = 'fails on Windows today: a TERM sent to the launcher does not get the block answer and the cleanup this test expects; not fixed yet';
const { hasPosixSh: posix, skipUnlessPosixSh } = require('./helpers/posix_sh');

// A Claude Code PreToolUse event that zn answers with a deny on stdout: reading zn's own config file.
function denyEvent(home) {
  return { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: path.join(home, '.zn', 'config.json') } };
}

function runNode(args, { home, input, closeRead, env = {} }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, ZN_STATS: 'off', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    if (closeRead) child.stdout.destroy();
    else child.stdout.on('data', (b) => { stdout += b; });
    child.stderr.on('data', (b) => { stderr += b; });
    child.on('error', reject);
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

const ENTRIES = [
  ['bin/cli.js hook', (agent) => [CLI, 'hook', agent]],
  ['lib/hooks/runner.js', (agent) => [RUNNER, agent]],
];

for (const [label, argsOf] of ENTRIES) {
  test('hook (' + label + '): a stdout that closed before the answer is written is a failure: status 1 under a launcher, never 0', async (t) => {
    const home = tempDir(t, 'zn-ov-home-');
    fs.mkdirSync(path.join(home, '.zn'), { recursive: true });
    const ack = path.join(tempDir(t, 'zn-ov-ack-'), 'ack');
    fs.writeFileSync(ack, '');
    const input = JSON.stringify(denyEvent(home));
    const closed = await runNode(argsOf('claude-code'), { home, input, closeRead: true, env: { ZN_HOOK_ACK: ack } });
    assert.equal(closed.signal, null);
    assert.equal(closed.code, 1, 'EPIPE on the answer: status 1 (the launcher then blocks)');
    assert.equal(fs.readFileSync(ack, 'utf8'), '', 'no confirmation for an answer that was not written');
    assert.doesNotMatch(closed.stderr, /^\s+at /m, 'no stack trace');
  });

  test('hook (' + label + '): a stdout that closed early with no launcher: exit 2 (the documented block) on a blocking event', async (t) => {
    const home = tempDir(t, 'zn-ov-home-');
    fs.mkdirSync(path.join(home, '.zn'), { recursive: true });
    const input = JSON.stringify(denyEvent(home));
    const closed = await runNode(argsOf('claude-code'), { home, input, closeRead: true });
    assert.equal(closed.code, 2);
  });

  test('hook (' + label + '): normal path: the answer is written, status 0 and the confirmation is in the ack file', async (t) => {
    const home = tempDir(t, 'zn-ov-home-');
    fs.mkdirSync(path.join(home, '.zn'), { recursive: true });
    const ack = path.join(tempDir(t, 'zn-ov-ack-'), 'ack');
    fs.writeFileSync(ack, '');
    const input = JSON.stringify(denyEvent(home));
    const r = await runNode(argsOf('claude-code'), { home, input, closeRead: false, env: { ZN_HOOK_ACK: ack } });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /"permissionDecision":\s*"deny"/);
    assert.equal(fs.readFileSync(ack, 'utf8'), 'ok');
    // An allowed call prints nothing and is confirmed all the same.
    const fine = { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: path.join(home, 'notes.txt') } };
    fs.writeFileSync(ack, '');
    const r2 = await runNode(argsOf('claude-code'), { home, input: JSON.stringify(fine), closeRead: false, env: { ZN_HOOK_ACK: ack } });
    assert.equal(r2.code, 0, r2.stderr);
    assert.equal(r2.stdout, '');
    assert.equal(fs.readFileSync(ack, 'utf8'), 'ok');
  });
}

test('hook: a refusal (exit 2) writes no confirmation and keeps its status', async (t) => {
  const home = tempDir(t, 'zn-ov-home-');
  const ack = path.join(tempDir(t, 'zn-ov-ack-'), 'ack');
  fs.writeFileSync(ack, '');
  const r = await runNode([RUNNER, 'claude-code'], { home, input: 'not json', env: { ZN_HOOK_ACK: ack } });
  assert.equal(r.code, 2);
  assert.equal(fs.readFileSync(ack, 'utf8'), '');
});

// ---- the POSIX launcher ----

function writeScript(t, agent, runnerBody, opts = {}) {
  const dir = tempDir(t, 'zn-ov-launch-');
  const runner = path.join(dir, 'runner.js');
  fs.writeFileSync(runner, runnerBody);
  const file = path.join(dir, 'launcher.sh');
  fs.writeFileSync(file, launcher.unixScript(agent, process.execPath, runner, opts), { mode: 0o755 });
  return file;
}

function runLauncher(file, event, input, { closeRead = false } = {}) {
  if (!closeRead) return Promise.resolve(spawnSync('/bin/sh', [file, event], { input, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: '/nonexistent' } }));
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', [file, event], { env: { PATH: process.env.PATH, HOME: '/nonexistent' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stdout.destroy();
    child.stderr.on('data', (b) => { stderr += b; });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    child.on('close', (code) => resolve({ status: code, stderr }));
  });
}

const PARTIAL = "process.stdout.write('{');\n";
const EMPTY_NO_ACK = "\n";
const GOOD = "process.stdout.write(JSON.stringify({ hookSpecificOutput: { permissionDecision: 'deny' } }));\nrequire('fs').writeFileSync(process.env.ZN_HOOK_ACK, 'ok');\n";
const ALLOW = "require('fs').writeFileSync(process.env.ZN_HOOK_ACK, 'ok');\n";

for (const [name, opts] of [['plain', {}], ['with a deadline', { deadlineS: 5 }]]) {
  test('posix launcher (' + name + '): a runner that prints "{" and exits 0 is a failure: a blocking event is blocked with the repair message', { skip: !posix }, async (t) => {
    const file = writeScript(t, 'claude-code', PARTIAL, opts);
    for (const ev of ['PreToolUse', 'UserPromptSubmit']) {
      const r = await runLauncher(file, ev, '{}');
      assert.equal(r.status, 2, ev);
      assert.match(r.stderr, /so this was blocked/);
      assert.doesNotMatch(r.stdout, /^\{$/m, 'the half answer is not passed on');
    }
    const post = await runLauncher(file, 'PostToolUse', '{}');
    assert.equal(post.status, 0);
    assert.match(JSON.parse(post.stdout).systemMessage, /NOT protecting this session/);
  });

  test('posix launcher (' + name + '): an empty answer with no confirmation is blocked; the same answer with the confirmation is an allow', { skip: !posix }, async (t) => {
    const bad = writeScript(t, 'claude-code', EMPTY_NO_ACK, opts);
    const r = await runLauncher(bad, 'PreToolUse', '{}');
    assert.equal(r.status, 2);
    assert.match(r.stderr, /so this was blocked/);
    const ok = writeScript(t, 'claude-code', ALLOW, opts);
    const r2 = await runLauncher(ok, 'PreToolUse', '{}');
    assert.equal(r2.status, 0, r2.stderr);
    assert.equal(r2.stdout, '');
  });

  test('posix launcher (' + name + '): a confirmed full answer passes through unchanged', { skip: !posix }, async (t) => {
    const file = writeScript(t, 'claude-code', GOOD, opts);
    const r = await runLauncher(file, 'PreToolUse', '{}');
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { hookSpecificOutput: { permissionDecision: 'deny' } });
  });

  test('posix launcher (' + name + '): the Daybreak case: the real runner cannot write its answer (EPIPE), so the launcher blocks instead of accepting status 0', { skip: skipUnlessPosixSh(EPIPE_ON_WINDOWS) }, async (t) => {
    const dir = tempDir(t, 'zn-ov-real-');
    const file = path.join(dir, 'launcher.sh');
    fs.writeFileSync(file, launcher.unixScript('claude-code', process.execPath, RUNNER, opts), { mode: 0o755 });
    const home = tempDir(t, 'zn-ov-home-');
    fs.mkdirSync(path.join(home, '.zn'), { recursive: true });
    const r = await new Promise((resolve) => {
      const child = spawn('/bin/sh', [file, 'PreToolUse'], { env: { PATH: process.env.PATH, HOME: home, ZN_STATS: 'off' }, stdio: ['pipe', 'pipe', 'pipe'] });
      child.stdout.destroy();
      let stderr = '';
      child.stderr.on('data', (b) => { stderr += b; });
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify(denyEvent(home)));
      child.on('close', (code) => resolve({ status: code, stderr }));
    });
    assert.equal(r.status, 2, 'before the fix this was 0: the deny never reached the agent and the call ran');
    assert.match(r.stderr, /so this was blocked/);
  });
}

test('posix launcher: the confirmation file is removed when the launcher ends', { skip: !posix }, async (t) => {
  const tmp = tempDir(t, 'zn-ov-tmp-');
  const file = writeScript(t, 'claude-code', GOOD);
  for (const body of [GOOD, PARTIAL]) {
    fs.writeFileSync(path.join(path.dirname(file), 'runner.js'), body);
    const r = spawnSync('/bin/sh', [file, 'PreToolUse'], { input: '{}', encoding: 'utf8', env: { PATH: process.env.PATH, HOME: '/nonexistent', TMPDIR: tmp } });
    assert.ok(r.status === 0 || r.status === 2);
    assert.deepEqual(fs.readdirSync(tmp), []);
  }
});

test('posix launcher: no confirmation file possible (unwritable temp folder): nothing is accepted as done, the call is blocked', { skip: !posix }, (t) => {
  const file = writeScript(t, 'claude-code', GOOD);
  const r = spawnSync('/bin/sh', [file, 'PreToolUse'], { input: '{}', encoding: 'utf8', env: { PATH: process.env.PATH, HOME: '/nonexistent', TMPDIR: '/nonexistent/zn-no-tmp' } });
  assert.equal(r.status, 2);
});

test('posix launcher: Antigravity (deny JSON on stdout) with a runner that prints "{": the launcher prints its own complete deny JSON', { skip: !posix }, async (t) => {
  const file = writeScript(t, 'antigravity', PARTIAL);
  const r = await runLauncher(file, 'PreToolUse', '{}');
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).decision, 'deny');
});

// ---- the Windows launcher: the text, and real PowerShell where there is one ----

test('windows launcher: a status 0 is accepted only with the confirmation (zk), and every exit removes the file', () => {
  for (const [agent, ev] of [['claude-code', 'PreToolUse'], ['codex', 'PreToolUse'], ['cursor', 'beforeShellExecution'], ['gemini', 'BeforeTool']]) {
    for (const deadlineS of [0, 5]) {
      const s = launcher.windowsScript(agent, ev, 'C:/node/node.exe', 'C:/z/runner.js', { deadlineS });
      assert.match(s, /ZN_HOOK_ACK/, agent);
      assert.ok(!/\$(LASTEXITCODE|rc) -eq 0 -or/.test(s), agent + ': no bare 0 check');
      assert.ok(/\(\$(LASTEXITCODE|rc) -eq 0 -and \(zk\)\)/.test(s), agent + ': 0 needs zk');
      assert.match(s, /exit [02] # zn hook /);
    }
  }
});

test('windows (real PowerShell): a runner that prints "{" and exits 0 does not count as an answer', { skip: process.platform !== 'win32' }, (t) => {
  const { windowsCommandScript } = require('../lib/shell-quote');
  const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const winPath = [path.join(process.env.SystemRoot || 'C:\\Windows', 'System32'), path.dirname(ps)].join(';');
  for (const deadlineS of [0, 5]) {
    const dir = tempDir(t, 'zn-ov-win-');
    const partial = path.join(dir, 'partial.js');
    fs.writeFileSync(partial, "process.stdout.write('{');\n");
    const good = path.join(dir, 'good.js');
    fs.writeFileSync(good, "require('fs').writeFileSync(process.env.ZN_HOOK_ACK, 'ok');\n");
    const run = (runner) => {
      const script = launcher.windowsScript('claude-code', 'PreToolUse', process.execPath.replace(/\\/g, '/'), runner.replace(/\\/g, '/'), { deadlineS });
      return spawnSync(ps, ['-NoProfile', '-NonInteractive', '-Command', script], { input: '{}', encoding: 'utf8', env: { ...process.env, PATH: winPath } });
    };
    const bad = run(partial);
    assert.equal(bad.status, 2, 'deadline ' + deadlineS + ': ' + bad.stdout + bad.stderr);
    assert.match(bad.stderr, /so this was blocked/);
    const ok = run(good);
    assert.equal(ok.status, 0, 'deadline ' + deadlineS + ': ' + ok.stderr);
    void windowsCommandScript;
  }
});

for (const [name, opts] of [['plain', {}], ['with a deadline', { deadlineS: 5 }]]) {
  test('posix launcher (' + name + '): the Daybreak case through the real runner: EPIPE on the answer is blocked, not accepted as status 0', { skip: skipUnlessPosixSh(EPIPE_ON_WINDOWS) }, async (t) => {
    const dir = tempDir(t, 'zn-ov-cli-');
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    fs.symlinkSync(process.execPath, path.join(bin, 'node'));
    fs.writeFileSync(path.join(bin, 'zn'), '#!/bin/sh\nexec "' + process.execPath + '" "' + CLI + '" "$@"\n', { mode: 0o755 });
    const file = path.join(dir, 'launcher.sh');
    // The launcher checks and runs zn-gate's own runner (it no longer falls back to `zn hook` from the PATH).
    fs.writeFileSync(file, launcher.unixScript('claude-code', process.execPath, path.resolve(__dirname, '..', 'lib', 'hooks', 'runner.js'), opts), { mode: 0o755 });
    const home = tempDir(t, 'zn-ov-home-');
    fs.mkdirSync(path.join(home, '.zn'), { recursive: true });
    const run = (closeRead) => new Promise((resolve) => {
      const child = spawn('/bin/sh', [file, 'PreToolUse'], { env: { PATH: bin + ':/usr/bin:/bin', HOME: home, ZN_STATS: 'off' }, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      if (closeRead) child.stdout.destroy();
      else child.stdout.on('data', (b) => { stdout += b; });
      child.stderr.on('data', (b) => { stderr += b; });
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify(denyEvent(home)));
      child.on('close', (code) => resolve({ status: code, stdout, stderr }));
    });
    const closed = await run(true);
    assert.equal(closed.status, 2, 'before the fix this was 0: zn hook swallowed the EPIPE and the launcher accepted it');
    assert.match(closed.stderr, /so this was blocked/);
    const normal = await run(false);
    assert.equal(normal.status, 0, normal.stderr);
    assert.match(normal.stdout, /"permissionDecision":\s*"deny"/);
  });
}

// ---- predictable temporary names (no mktemp): a FIFO or link planted at the name is never used ----

function noMktempScript(t, runnerBody) {
  const file = writeScript(t, 'claude-code', runnerBody);
  const text = fs.readFileSync(file, 'utf8').replace('/usr/bin/mktemp /bin/mktemp', '/nonexistent/mktemp');
  assert.ok(text.includes('/nonexistent/mktemp'));
  fs.writeFileSync(file, text, { mode: 0o755 });
  return file;
}

function runPlanted(file, tmp, plant) {
  // `exec` keeps the PID, so the names the launcher would try first are known before it runs.
  // A fixed wrapper script; the planting commands (a constant of each test) arrive in the environment.
  const wrapper = path.join(tmp, 'plant-wrapper.sh');
  fs.writeFileSync(wrapper, '#!/bin/sh\nfor n in ack out; do eval "$ZN_PLANT"; done\nexec /bin/sh "$1" PreToolUse\n', { mode: 0o755 });
  return spawnSync('/bin/sh', [wrapper, file], { input: '{}', encoding: 'utf8', timeout: 15000, env: { PATH: process.env.PATH, HOME: '/nonexistent', TMPDIR: tmp, ZN_PLANT: plant } });
}

test('posix launcher (no mktemp): a FIFO and a link planted at the predictable names are skipped; the answer is the runner\'s', { skip: !posix }, (t) => {
  const tmp = tempDir(t, 'zn-ov-plant-');
  const file = noMktempScript(t, GOOD);
  const r = runPlanted(file, tmp, 'mkfifo "$TMPDIR/zn-$n.$$.1"; ln -s /dev/null "$TMPDIR/zn-$n.$$.2"');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { hookSpecificOutput: { permissionDecision: 'deny' } });
});

test('posix launcher (no mktemp): every name taken by a FIFO: blocked at once, no hang', { skip: !posix }, (t) => {
  const tmp = tempDir(t, 'zn-ov-plant-');
  const file = noMktempScript(t, GOOD);
  const r = runPlanted(file, tmp, 'for i in 1 2 3 4 5 6; do mkfifo "$TMPDIR/zn-$n.$$.$i"; done');
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /so this was blocked/);
});

test('posix launcher (with mktemp): a FIFO at the old predictable name changes nothing', { skip: !posix }, (t) => {
  const tmp = tempDir(t, 'zn-ov-plant-');
  const file = writeScript(t, 'claude-code', GOOD);
  const r = runPlanted(file, tmp, 'mkfifo "$TMPDIR/zn-$n.$$.1"');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny');
});

// ---- with the hook supervisor ----

test('posix launcher + supervisor: a post-tool event the check could not finish gets the supervisor\'s withheld notice, not the launcher\'s warning', { skip: !posix }, async (t) => {
  const dir = tempDir(t, 'zn-ov-sup-');
  const file = path.join(dir, 'launcher.sh');
  fs.writeFileSync(file, launcher.unixScript('claude-code', process.execPath, RUNNER, {}), { mode: 0o755 });
  const home = tempDir(t, 'zn-ov-home-');
  const r = await new Promise((resolve) => {
    const child = spawn('/bin/sh', [file, 'PostToolUse'], { env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, ZN_STATS: 'off', ZN_TEST_HOOK_FAULTS: '1', ZN_TEST_HOOK_DEADLINE_MS: '1500' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (b) => { stdout += b; });
    child.stdin.on('error', () => {});
    // the event never ends: the supervisor answers for it
    child.stdin.write('{"hook_event_name":"PostToolUse","tool_name":"Bash","tool_response":"');
    child.on('close', (code) => { resolve({ status: code, stdout }); });
  });
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.stdout, /NOT protecting this session/, 'the launcher warning is not what came back');
  assert.ok(JSON.parse(r.stdout.trim()), 'a complete JSON answer');
});

test('posix launcher: a status 0 without the confirmation (an older zn on the PATH) gets its own message that says how to fix it', { skip: !posix }, async (t) => {
  const file = writeScript(t, 'claude-code', EMPTY_NO_ACK);
  const r = await runLauncher(file, 'PreToolUse', '{}');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /older than this hook/);
  assert.match(r.stderr, /npm install -g zn-gate.*zn hooks install claude-code/);
  const post = await runLauncher(file, 'PostToolUse', '{}');
  assert.match(JSON.parse(post.stdout).systemMessage, /zn hooks install claude-code/);
});

// ---- private files: every call removes what it made, whatever the PATH of the hook (it can be empty) ----

const zfiles = (dir) => fs.readdirSync(dir).filter((f) => f.startsWith('zn-'));

const HOOKS = [
  ['answer + ack', GOOD, (r) => assert.equal(r.status, 0)],
  ['allow + ack', ALLOW, (r) => assert.equal(r.status, 0)],
  ['block (exit 2)', "process.stdout.write('x'); process.exit(2);\n", (r) => assert.equal(r.status, 2)],
  ['status 0 without ack', PARTIAL, (r) => assert.equal(r.status, 2)],
  ['crash (exit 1)', 'process.exit(1);\n', (r) => assert.equal(r.status, 2)],
];
const MODES = [
  ['no deadline', {}, null],
  ['deadline', { deadlineS: 5 }, null],
  ['soft deadline, no timer', { deadlineS: 5, deadlineSoft: true }, (s) => s.split('[ -x /bin/sleep ]').join('[ -x /nonexistent/sleep ]')],
];

for (const [mode, opts, edit] of MODES) {
  for (const [pathName, PATHV] of [['the usual PATH', process.env.PATH], ['an empty PATH', '']]) {
    test('posix launcher, ' + mode + ', ' + pathName + ': no private file is left behind after any answer', { skip: !posix }, (t) => {
      for (const [name, body, check] of HOOKS) {
        const tmp = tempDir(t, 'zn-ov-clean-');
        const file = writeScript(t, 'claude-code', body, opts);
        if (edit) fs.writeFileSync(file, edit(fs.readFileSync(file, 'utf8')), { mode: 0o755 });
        for (let i = 0; i < 5; i++) {
          const r = spawnSync('/bin/sh', [file, 'PreToolUse'], { input: '{}', encoding: 'utf8', timeout: 20000, env: { PATH: PATHV, HOME: '/nonexistent', TMPDIR: tmp } });
          check(r);
        }
        assert.deepEqual(zfiles(tmp), [], name + ': files left in TMPDIR');
      }
      const tmp = tempDir(t, 'zn-ov-clean-gone-');
      const gone = path.join(tempDir(t, 'zn-ov-clean-dir-'), 'launcher.sh');
      fs.writeFileSync(gone, launcher.unixScript('claude-code', '/nonexistent/node', '/nonexistent/runner.js', opts), { mode: 0o755 });
      const r = spawnSync('/bin/sh', [gone, 'PreToolUse'], { input: '{}', encoding: 'utf8', env: { PATH: PATHV, HOME: '/nonexistent', TMPDIR: tmp } });
      assert.equal(r.status, 2, r.stderr);
      assert.deepEqual(zfiles(tmp), [], 'zn gone: files left in TMPDIR');
    });
  }
}

test('posix launcher, no deadline: a TERM while the hook runs answers with the block and removes the private files', { skip: skipUnlessPosixSh(TERM_ON_WINDOWS) }, async (t) => {
  const tmp = tempDir(t, 'zn-ov-clean-term-');
  const file = writeScript(t, 'claude-code', "setTimeout(() => { require('fs').writeFileSync(process.env.ZN_HOOK_ACK, 'ok'); }, 800);\n");
  const child = spawn('/bin/sh', [file, 'PreToolUse'], { env: { PATH: '', HOME: '/nonexistent', TMPDIR: tmp }, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.end('{}');
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(zfiles(tmp).length >= 2, 'the launcher made its private files');
  child.kill('SIGTERM');
  assert.equal(await exited, 2);
  assert.deepEqual(zfiles(tmp), []);
});

test('posix launcher with a deadline and an empty PATH still runs the hook (its private files do not depend on the PATH)', { skip: !posix }, (t) => {
  const tmp = tempDir(t, 'zn-ov-clean-strict-');
  const file = writeScript(t, 'zcode', GOOD, { deadlineS: 5 });
  const r = spawnSync('/bin/sh', [file, 'PreToolUse'], { input: '{}', encoding: 'utf8', timeout: 20000, env: { PATH: '', HOME: '/nonexistent', TMPDIR: tmp } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { hookSpecificOutput: { permissionDecision: 'deny' } });
  assert.deepEqual(zfiles(tmp), []);
});

// ---- commands planted in the project: with `.`, an empty entry or a relative folder on the PATH, the launcher runs none of them ----

const PLANTED = ['rm', 'mktemp', 'cat', 'sleep', 'kill', 'wait', 'setsid', 'perl', 'printf', 'read', 'test', '[', 'echo', 'umask', 'trap', 'env', 'sh',
  'true', 'false', 'id', 'chmod', 'mkdir', 'ls', 'tee', 'timeout', 'head', 'tail', 'tr', 'sed', 'awk', 'grep', 'node', 'zn', 'touch', 'date', 'stat',
  'xargs', 'basename', 'dirname', 'readlink', 'mv', 'cp', 'ln', 'expr', 'uname', 'which', 'nohup', 'pkill', 'ps', 'taskkill'];

function plantProject(t) {
  const proj = tempDir(t, 'zn-ov-planted-');
  const mark = path.join(proj, 'RAN');
  for (const dir of [proj, path.join(proj, 'bin')]) {
    fs.mkdirSync(dir, { recursive: true });
    for (const name of PLANTED) fs.writeFileSync(path.join(dir, name), '#!/bin/sh\necho "$0 $*" >>' + JSON.stringify(mark) + '\nexit 0\n', { mode: 0o755 });
  }
  return { proj, mark };
}

for (const [mode, opts, edit] of MODES) {
  test('posix launcher, ' + mode + ': rm, mktemp, cat and other commands planted in the project are never run, whatever relative entry the PATH has', { skip: !posix }, (t) => {
    const { proj, mark } = plantProject(t);
    const gone = path.join(tempDir(t, 'zn-ov-planted-gone-'), 'launcher.sh');
    fs.writeFileSync(gone, launcher.unixScript('claude-code', '/nonexistent/node', '/nonexistent/runner.js', opts), { mode: 0o755 });
    const cases = [...HOOKS.map(([name, body, check]) => [name, writeScript(t, 'claude-code', body, opts), check]), ['zn gone', gone, (r) => assert.equal(r.status, 2)]];
    for (const [name, file, check] of cases) {
      if (edit) fs.writeFileSync(file, edit(fs.readFileSync(file, 'utf8')), { mode: 0o755 });
      for (const PATHV of ['.', '.:/usr/bin:/bin', ':/usr/bin:/bin', 'bin:/usr/bin:/bin', '/usr/bin:/bin:.']) {
        const tmp = tempDir(t, 'zn-ov-planted-tmp-');
        const r = spawnSync('/bin/sh', [file, 'PreToolUse'], { cwd: proj, input: '{}', encoding: 'utf8', timeout: 20000, env: { PATH: PATHV, HOME: '/nonexistent', TMPDIR: tmp } });
        check(r);
        if (name === 'answer + ack') assert.deepEqual(JSON.parse(r.stdout), { hookSpecificOutput: { permissionDecision: 'deny' } }, name + ' PATH=' + PATHV);
        assert.equal(fs.existsSync(mark) ? fs.readFileSync(mark, 'utf8') : '', '', name + ' PATH=' + PATHV + ': a planted command ran');
        assert.deepEqual(zfiles(tmp), [], name + ' PATH=' + PATHV + ': files left in TMPDIR');
      }
    }
  });
}

test('posix launcher with a deadline: a TERM with `.` first on the PATH runs no planted command', { skip: skipUnlessPosixSh(TERM_ON_WINDOWS) }, async (t) => {
  const { proj, mark } = plantProject(t);
  const tmp = tempDir(t, 'zn-ov-planted-term-');
  const file = writeScript(t, 'claude-code', 'process.stdin.resume(); setInterval(() => {}, 1000);\n', { deadlineS: 30 });
  const child = spawn('/bin/sh', [file, 'PreToolUse'], { cwd: proj, env: { PATH: '.:/usr/bin:/bin', HOME: '/nonexistent', TMPDIR: tmp }, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.write('{');
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  await new Promise((r) => setTimeout(r, 400));
  child.kill('SIGTERM');
  assert.equal(await exited, 2);
  assert.equal(fs.existsSync(mark) ? fs.readFileSync(mark, 'utf8') : '', '');
  assert.deepEqual(zfiles(tmp), []);
});

// ---- Windows: zn and node are looked up only in fully qualified PATH entries ----

test('windows launchers: every zn.cmd call runs after the PATH keeps only absolute entries and cmd.exe stops looking in the current folder', () => {
  const PREFIX = "$env:NoDefaultCurrentDirectoryInExePath = '1'; $env:PATH = (($env:PATH -split ';') -match ";
  const scripts = [];
  for (const [agent, event] of [['claude-code', 'PreToolUse'], ['cursor', 'preToolUse'], ['gemini', 'BeforeTool'], ['codex', 'PreToolUse'], ['zcode', 'PreToolUse'], ['zcode', 'PostToolUse']]) {
    for (const opts of [{}, { deadlineS: 26 }]) {
      const s = launcher.windowsScript(agent, event, 'C:/no-such/node.exe', 'C:/no-such/runner.js', opts);
      if (s) scripts.push([agent + ' ' + event + ' ' + JSON.stringify(opts), s]);
    }
  }
  for (const agent of ['claude-code', 'codex', 'cursor', 'gemini', 'copilot']) {
    try { const s = launcher.projectWindowsScript(agent); if (s) scripts.push(['project ' + agent, s]); } catch (_) { /* no Windows project form for this agent */ }
  }
  assert.ok(scripts.length >= 6, 'scripts generated: ' + scripts.length);
  for (const [name, s] of scripts) {
    const p = s.indexOf(PREFIX);
    assert.ok(p >= 0, name + ': no PATH guard');
    let k = s.indexOf('zn.cmd');
    assert.ok(k >= 0, name + ': no zn.cmd call');
    for (; k >= 0; k = s.indexOf('zn.cmd', k + 1)) assert.ok(k > p, name + ': zn.cmd before the PATH guard');
  }
});

test('windows (real PowerShell): the fallback runs the real zn.cmd, and the node it starts is never one planted in the project', { skip: process.platform !== 'win32' }, (t) => {
  const { getAdapter } = require('../lib/agents');
  const home = tempDir(t, 'zn-ov-winplant-');
  const proj = tempDir(t, 'zn-ov-winplant-proj-');
  const bin = tempDir(t, 'zn-ov-winplant-bin-');
  const mark = path.join(proj, 'RAN');
  // In the project (the folder the agent runs in): programs that must never run.
  for (const name of ['zn.cmd', 'node.cmd', 'node.bat']) fs.writeFileSync(path.join(proj, name), '@echo ran>>"' + mark + '"\r\n@exit /b 0\r\n');
  // A real zn.cmd in an absolute folder, which starts `node` through cmd.exe like the npm shim does when no node.exe sits next to it.
  fs.writeFileSync(path.join(bin, 'zn.cmd'), '@node "' + RUNNER + '" %2\r\n');
  const adapter = getAdapter('cursor');
  adapter.install({ home, env: { HOME: home, ZN_HOME: path.join(home, '.zn') }, platform: 'win32', nodePath: String.raw`C:\no-such\node.exe`, runnerPath: String.raw`C:\no-such\runner.js`, mcp: false });
  const data = JSON.parse(fs.readFileSync(adapter.hooksFile({ home, env: { HOME: home } }), 'utf8'));
  const g = data.hooks.beforeShellExecution[0];
  const cmd = (g.hooks ? g.hooks[0] : g).command;
  const sys32 = path.join(process.env.SystemRoot || String.raw`C:\Windows`, 'System32');
  const ps = path.join(sys32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const winPath = ['.', '', bin, path.dirname(process.execPath), sys32, path.dirname(ps)].join(';');
  const r = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-Command', cmd], { cwd: proj, input: '{}', encoding: 'utf8', env: { ...process.env, PATH: winPath, HOME: home, USERPROFILE: home, ZN_STATS: 'off' } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(mark), false, 'a program planted in the project ran');
});

// ---- no rm, mktemp or cat in the usual system folders (NixOS, Guix): the private files are still removed ----

test('posix launcher without /bin/rm, mktemp or cat in the system folders: no private file is left, and nothing is taken from the PATH', { skip: !posix }, (t) => {
  const strip = (text) => text
    .replace('/bin/rm /usr/bin/rm /run/current-system/sw/bin/rm /run/current-system/profile/bin/rm', '/nonexistent/rm')
    .replace('/usr/bin/mktemp /bin/mktemp /run/current-system/sw/bin/mktemp /run/current-system/profile/bin/mktemp', '/nonexistent/mktemp')
    .replace('/bin/cat /usr/bin/cat /run/current-system/sw/bin/cat /run/current-system/profile/bin/cat', '/nonexistent/cat');
  const { proj, mark } = plantProject(t);
  for (const [mode, opts, edit] of MODES) {
    for (const [name, body, check] of HOOKS) {
      const file = writeScript(t, 'claude-code', body, opts);
      const text = strip(fs.readFileSync(file, 'utf8'));
      assert.ok(text.includes('/nonexistent/rm') && text.includes('/nonexistent/mktemp') && text.includes('/nonexistent/cat'), 'the system folders were replaced');
      fs.writeFileSync(file, edit ? edit(text) : text, { mode: 0o755 });
      const tmp = tempDir(t, 'zn-ov-nix-');
      for (let i = 0; i < 3; i++) {
        // The tools are on the PATH (as on NixOS), and planted ones in the project come first: none of them may run.
        const r = spawnSync('/bin/sh', [file, 'PreToolUse'], { cwd: proj, input: '{}', encoding: 'utf8', timeout: 20000, env: { PATH: '.:/usr/bin:/bin', HOME: '/nonexistent', TMPDIR: tmp } });
        check(r);
      }
      assert.deepEqual(zfiles(tmp), [], mode + ', ' + name + ': files left in TMPDIR');
      assert.equal(fs.existsSync(mark) ? fs.readFileSync(mark, 'utf8') : '', '', mode + ', ' + name + ': a planted command ran');
    }
  }
});

// ---- a TMPDIR whose path starts with "-": rm, cat and node never read a private file name as an option ----

test('posix launcher with a TMPDIR that starts with "-": the answer passes and no private file is left, with or without rm', { skip: !posix }, (t) => {
  const strip = (text) => text.replace('/bin/rm /usr/bin/rm /run/current-system/sw/bin/rm /run/current-system/profile/bin/rm', '/nonexistent/rm');
  for (const [mode, opts, edit] of MODES) {
    for (const noRm of [false, true]) {
      const file = writeScript(t, 'claude-code', GOOD, opts);
      let text = fs.readFileSync(file, 'utf8');
      if (noRm) text = strip(text);
      if (edit) text = edit(text);
      fs.writeFileSync(file, text, { mode: 0o755 });
      const base = tempDir(t, 'zn-ov-dash-');
      fs.mkdirSync(path.join(base, '-tmp'));
      for (let i = 0; i < 3; i++) {
        const r = spawnSync('/bin/sh', [file, 'PreToolUse'], { cwd: base, input: '{}', encoding: 'utf8', timeout: 20000, env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent', TMPDIR: '-tmp' } });
        assert.equal(r.status, 0, mode + (noRm ? ', no rm' : '') + ': ' + r.stderr);
        assert.deepEqual(JSON.parse(r.stdout), { hookSpecificOutput: { permissionDecision: 'deny' } });
      }
      assert.deepEqual(zfiles(path.join(base, '-tmp')), [], mode + (noRm ? ', no rm' : '') + ': files left');
    }
  }
});
